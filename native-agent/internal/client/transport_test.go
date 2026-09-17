package client

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestRedirectAddrKeepsOriginalPort(t *testing.T) {
	if got := redirectAddr("dsp.logikos.dev:443", "20.20.0.92"); got != "20.20.0.92:443" {
		t.Fatalf("got %q", got)
	}
}

func TestRedirectAddrHonorsAnOverridePort(t *testing.T) {
	if got := redirectAddr("dsp.logikos.dev:443", "20.20.0.92:8443"); got != "20.20.0.92:8443" {
		t.Fatalf("got %q", got)
	}
}

func TestRejectsACAFileWithNoCertificates(t *testing.T) {
	if _, err := NewHTTPClient("", []byte("not a certificate"), time.Second); err == nil {
		t.Fatal("expected an error for a CA file containing no certificates")
	}
}

// The case this whole file exists for: reach a server by its LAN address
// while still verifying the certificate against the hostname in the URL, and
// trust that certificate through the configured CA rather than the system
// roots. httptest's certificate is issued for example.com (and 127.0.0.1),
// so requesting https://example.com/ and dialling 127.0.0.1 exercises both.
func TestDialsTheOverrideAddressAndVerifiesTheURLHostname(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "example.com" {
			t.Errorf("server saw Host %q, want example.com", r.Host)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	_, port, err := net.SplitHostPort(mustURL(t, srv.URL).Host)
	if err != nil {
		t.Fatal(err)
	}

	c, err := NewHTTPClient(net.JoinHostPort("127.0.0.1", port), caPEM, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Get("https://example.com/health")
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", res.StatusCode)
	}
}

// Without the CA the same request must fail — proof the test above passed
// because the certificate was trusted, not because verification was off.
func TestWithoutTheConfiguredCAVerificationStillFails(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	_, port, err := net.SplitHostPort(mustURL(t, srv.URL).Host)
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewHTTPClient(net.JoinHostPort("127.0.0.1", port), nil, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Get("https://example.com/health")
	if err == nil {
		t.Fatal("expected certificate verification to fail without the configured CA")
	}
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) {
		t.Fatalf("expected an unknown-authority error, got %v", err)
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
