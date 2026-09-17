// Package client talks to the exact same backend endpoints
// packages/agent/src/client.ts does — same URLs, same JSON shapes (see
// internal/wire) — so this agent is a drop-in wire replacement, not a new
// protocol.
package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/logikos-dsp/native-agent/internal/wire"
)

// Client authenticates like packages/agent/src/agentSession.ts: Register
// presents the enroll token and keeps the per-agent secret it returns; every
// other call sends that secret, and a 401 triggers one re-registration and
// retry (throttled), since the backend rotates the secret on each
// registration. A 403 means the agent was revoked and is returned as-is.
type Client struct {
	baseURL     string
	enrollToken string
	http        *http.Client

	minReregisterInterval time.Duration
	now                   func() time.Time

	regMu          sync.Mutex
	mu             sync.Mutex
	registration   wire.RegisterRequest
	secret         string
	lastReregister time.Time
}

// Option adjusts a Client at construction. Variadic rather than a second
// constructor so every existing call site — and the Linux deployment they
// represent — keeps working untouched.
type Option func(*Client)

// WithHTTPClient supplies the transport, for agents that must dial a specific
// address or trust a private CA (see NewHTTPClient).
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.http = h }
}

func New(baseURL, enrollToken string, opts ...Option) *Client {
	c := &Client{
		baseURL:               baseURL,
		enrollToken:           enrollToken,
		http:                  &http.Client{Timeout: 15 * time.Second},
		minReregisterInterval: 5 * time.Second,
		now:                   time.Now,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// send builds a fresh request per attempt (a body reader can't be replayed).
func (c *Client) send(method, path string, body []byte, bearer string) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	return c.http.Do(req)
}

func statusError(method, path string, res *http.Response) error {
	respBody, _ := io.ReadAll(res.Body)
	return fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, string(respBody))
}

// Register mirrors packages/agent/src/client.ts's register — POST
// /agents/register with the enroll token, idempotent on key, returning a
// fresh agent secret that replaces any previous one.
func (c *Client) Register(key, hostname, watchedRoot string) error {
	c.mu.Lock()
	c.registration = wire.RegisterRequest{Key: key, Hostname: hostname, WatchedRoot: watchedRoot}
	c.mu.Unlock()
	return c.register()
}

func (c *Client) register() error {
	c.mu.Lock()
	reg := c.registration
	c.mu.Unlock()

	buf, err := json.Marshal(reg)
	if err != nil {
		return fmt.Errorf("marshal register request: %w", err)
	}
	res, err := c.send(http.MethodPost, "/agents/register", buf, c.enrollToken)
	if err != nil {
		return fmt.Errorf("POST /agents/register: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return statusError(http.MethodPost, "/agents/register", res)
	}
	var out wire.RegisterResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return fmt.Errorf("decode register response: %w", err)
	}
	if out.AgentSecret == "" {
		return fmt.Errorf("register response carried no agentSecret")
	}
	c.mu.Lock()
	c.secret = out.AgentSecret
	c.mu.Unlock()
	return nil
}

// do sends an authenticated request; the caller closes the returned body.
func (c *Client) do(method, path string, body []byte) (*http.Response, error) {
	c.mu.Lock()
	used := c.secret
	c.mu.Unlock()

	res, err := c.send(method, path, body, used)
	if err != nil || res.StatusCode != http.StatusUnauthorized {
		return res, err
	}

	// regMu serializes 401 recovery: a request that queues behind an
	// in-progress re-registration finds the secret already changed and just
	// retries with it instead of registering again.
	c.regMu.Lock()
	c.mu.Lock()
	stale := c.secret == used
	throttled := stale && c.now().Sub(c.lastReregister) < c.minReregisterInterval
	if stale && !throttled {
		c.lastReregister = c.now()
	}
	c.mu.Unlock()
	if stale && !throttled {
		log.Printf("agent credentials rejected (401); re-registering")
		if err := c.register(); err != nil {
			log.Printf("re-registration failed: %v", err)
		}
	}
	c.regMu.Unlock()

	c.mu.Lock()
	retry := c.secret
	c.mu.Unlock()
	if retry == used {
		return res, nil
	}
	res.Body.Close()
	return c.send(method, path, body, retry)
}

func (c *Client) postJSON(path string, body any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal request body: %w", err)
	}
	res, err := c.do(http.MethodPost, path, buf)
	if err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return statusError(http.MethodPost, path, res)
	}
	return nil
}

// PostEvents mirrors postEvents — POST /ingest/events. Caller is
// responsible for batching (max 500 per the backend's Zod schema); this
// just sends whatever slice it's given.
func (c *Client) PostEvents(events []wire.FileEvent) error {
	if len(events) == 0 {
		return nil
	}
	return c.postJSON("/ingest/events", events)
}

// PostStorageSnapshot mirrors postStorageSnapshot — POST /ingest/storage.
func (c *Client) PostStorageSnapshot(snapshot wire.StorageSnapshot) error {
	return c.postJSON("/ingest/storage", snapshot)
}

// QuarantineCommand mirrors packages/agent/src/client.ts's
// QuarantineCommand — one or many paths per command (a single sensitive-
// data alert vs. a ransomware-rate burst, see ARCHITECTURE.md).
type QuarantineCommand struct {
	ID    string   `json:"id"`
	Paths []string `json:"paths"`
}

// FetchQuarantineCommands mirrors fetchQuarantineCommands — GET
// /agent-commands?agentKey=...
func (c *Client) FetchQuarantineCommands(agentKey string) ([]QuarantineCommand, error) {
	res, err := c.do(http.MethodGet, "/agent-commands?"+url.Values{"agentKey": {agentKey}}.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("GET /agent-commands: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("GET /agent-commands: %d %s", res.StatusCode, string(body))
	}
	var commands []QuarantineCommand
	if err := json.NewDecoder(res.Body).Decode(&commands); err != nil {
		return nil, fmt.Errorf("decode /agent-commands response: %w", err)
	}
	return commands, nil
}

// CompleteQuarantineCommand mirrors completeQuarantineCommand — POST
// /agent-commands/:id/complete.
func (c *Client) CompleteQuarantineCommand(agentKey, id string, success bool, message string) error {
	return c.postJSON(fmt.Sprintf("/agent-commands/%s/complete", id), map[string]any{
		"agentKey": agentKey,
		"success":  success,
		"message":  message,
	})
}
