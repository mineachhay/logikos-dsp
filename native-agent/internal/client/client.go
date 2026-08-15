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
	"net/http"
	"net/url"
	"time"

	"github.com/logikos-dsp/native-agent/internal/wire"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string) *Client {
	return &Client{baseURL: baseURL, http: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Client) postJSON(path string, body any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal request body: %w", err)
	}
	res, err := c.http.Post(c.baseURL+path, "application/json", bytes.NewReader(buf))
	if err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		respBody, _ := io.ReadAll(res.Body)
		return fmt.Errorf("POST %s: %d %s", path, res.StatusCode, string(respBody))
	}
	return nil
}

// Register mirrors packages/agent/src/client.ts's registerAgent — POST
// /agents/register, idempotent on key.
func (c *Client) Register(key, hostname, watchedRoot string) error {
	return c.postJSON("/agents/register", wire.RegisterRequest{
		Key:         key,
		Hostname:    hostname,
		WatchedRoot: watchedRoot,
	})
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
	u := c.baseURL + "/agent-commands?" + url.Values{"agentKey": {agentKey}}.Encode()
	res, err := c.http.Get(u)
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
