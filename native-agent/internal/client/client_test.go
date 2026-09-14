package client

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/logikos-dsp/native-agent/internal/wire"
)

// fakeBackend accepts only the most recently issued secret, like the real
// backend's rotation on /agents/register.
type fakeBackend struct {
	mu            sync.Mutex
	issued        int
	current       string
	revoked       bool
	registrations int
}

func (f *fakeBackend) rotateElsewhere() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issued++
	f.current = fmt.Sprintf("secret-%d", f.issued)
}

func (f *fakeBackend) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		auth := r.Header.Get("Authorization")
		if r.URL.Path == "/agents/register" {
			if auth != "Bearer enroll-token" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if f.revoked {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			f.registrations++
			f.issued++
			f.current = fmt.Sprintf("secret-%d", f.issued)
			_ = json.NewEncoder(w).Encode(wire.RegisterResponse{ID: "id", AgentSecret: f.current})
			return
		}
		if f.revoked {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if auth != "Bearer "+f.current {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
}

func setup(t *testing.T) (*fakeBackend, *Client) {
	t.Helper()
	f := &fakeBackend{}
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	c := New(srv.URL, "enroll-token")
	if err := c.Register("agent-key", "host", "/watch"); err != nil {
		t.Fatalf("register: %v", err)
	}
	return f, c
}

func snapshot() wire.StorageSnapshot {
	return wire.StorageSnapshot{AgentKey: "agent-key", RootPath: "/watch", TakenAt: "2026-01-01T00:00:00Z"}
}

func TestRegisterFailsWithWrongEnrollToken(t *testing.T) {
	f := &fakeBackend{}
	srv := httptest.NewServer(f.handler(t))
	defer srv.Close()
	if err := New(srv.URL, "wrong").Register("agent-key", "host", "/watch"); err == nil {
		t.Fatal("expected registration with a wrong enroll token to fail")
	}
}

func TestSendsIssuedSecret(t *testing.T) {
	f, c := setup(t)
	if err := c.PostStorageSnapshot(snapshot()); err != nil {
		t.Fatalf("post: %v", err)
	}
	if f.registrations != 1 {
		t.Fatalf("registrations = %d, want 1", f.registrations)
	}
}

func TestReregistersOnceOn401(t *testing.T) {
	f, c := setup(t)
	f.rotateElsewhere()
	if err := c.PostStorageSnapshot(snapshot()); err != nil {
		t.Fatalf("post after rotation: %v", err)
	}
	if f.registrations != 2 {
		t.Fatalf("registrations = %d, want 2", f.registrations)
	}
}

func TestConcurrent401sShareOneReregistration(t *testing.T) {
	f, c := setup(t)
	f.rotateElsewhere()
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = c.PostStorageSnapshot(snapshot())
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("request %d: %v", i, err)
		}
	}
	if f.registrations != 2 {
		t.Fatalf("registrations = %d, want 2", f.registrations)
	}
}

func TestThrottlesRepeatedReregistration(t *testing.T) {
	f, c := setup(t)
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }

	f.rotateElsewhere()
	_ = c.PostStorageSnapshot(snapshot()) // re-registers (2)
	f.rotateElsewhere()
	now = now.Add(time.Second)
	if err := c.PostStorageSnapshot(snapshot()); err == nil {
		t.Fatal("expected a 401 inside the throttle window")
	}
	if f.registrations != 2 {
		t.Fatalf("registrations = %d, want 2 (throttled)", f.registrations)
	}
	now = now.Add(10 * time.Second)
	if err := c.PostStorageSnapshot(snapshot()); err != nil {
		t.Fatalf("post after window: %v", err)
	}
}

func TestRevokedIsNotRetried(t *testing.T) {
	f, c := setup(t)
	f.mu.Lock()
	f.revoked = true
	f.mu.Unlock()
	if err := c.PostStorageSnapshot(snapshot()); err == nil {
		t.Fatal("expected revoked agent's post to fail")
	}
	if f.registrations != 1 {
		t.Fatalf("registrations = %d, want 1", f.registrations)
	}
}
