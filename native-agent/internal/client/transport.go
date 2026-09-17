package client

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"time"
)

// NewHTTPClient builds the transport an agent on a workstation needs, which
// differs from the bundled agent's in two ways that both come from where the
// backend actually sits.
//
// connectIP dials a specific address while still presenting — and verifying —
// the hostname in the URL. On this deployment the backend is published behind
// a CDN, so resolving dsp.logikos.dev sends every file event out to the
// internet and back to reach a server on the same LAN. Pointing the agent
// straight at the origin's LAN address avoids that round trip, and it has to
// be done at dial time rather than by putting the IP in the URL: the origin
// certificate carries DNS names only, so an https://<ip>/ URL fails hostname
// verification, and nginx routes by server_name — a bare IP lands on whichever
// vhost happens to be first, not on this one.
//
// caPEM trusts a private CA in addition to the system roots. The origin
// certificate here is issued by Cloudflare's Origin CA, which no Windows
// machine trusts by default; going direct to the origin means supplying it.
// Appended to a copy of the system pool rather than replacing it, so an agent
// configured this way still trusts ordinary public certificates — this is
// additive trust, never a downgrade, and there is deliberately no option to
// skip verification.
func NewHTTPClient(connectIP string, caPEM []byte, timeout time.Duration) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()

	if len(caPEM) > 0 {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			// Windows has historically not implemented SystemCertPool; an
			// empty pool plus the configured CA still verifies the one
			// server this agent talks to, which is the case that matters.
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, fmt.Errorf("no certificates found in the configured CA file")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}

	if connectIP != "" {
		dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, redirectAddr(addr, connectIP))
		}
	}

	return &http.Client{Timeout: timeout, Transport: transport}, nil
}

// redirectAddr swaps the host of a dial address for the configured one,
// keeping the original port unless the override names its own. Only the
// address dialled changes; the TLS handshake still uses the URL's hostname
// for SNI and certificate verification, which is the entire point.
func redirectAddr(addr, connectIP string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if host, overridePort, err := net.SplitHostPort(connectIP); err == nil {
		return net.JoinHostPort(host, overridePort)
	}
	return net.JoinHostPort(connectIP, port)
}
