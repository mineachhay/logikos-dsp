package watch

import (
	"encoding/base64"
	"io"
	"os"
)

// readSample base64-encodes the first maxBytes of a file — matches
// watcher.ts's sampleContent (readFile then subarray then base64), same
// contract: any read failure (already gone, permission denied) is silent,
// the event still reports without a contentSample rather than failing.
func readSample(path string, maxBytes int) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	buf := make([]byte, maxBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf[:n]), nil
}
