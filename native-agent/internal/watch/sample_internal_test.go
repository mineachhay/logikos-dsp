package watch

import "testing"

// Mirrors packages/agent/src/contentSampling.test.ts's cases exactly —
// same extension set, same size cap, same pure-function-no-I/O shape.
func TestIsSampleable(t *testing.T) {
	cases := []struct {
		name      string
		path      string
		sizeBytes int64
		want      bool
	}{
		{"text extension under the cap", "notes.txt", 100, true},
		{"case-insensitive extension", "NOTES.TXT", 100, true},
		{"non-textish extension", "photo.png", 100, false},
		{"no extension at all", "README", 100, false},
		{"textish but over the size cap", "huge.csv", maxSampleableFileBytes + 1, false},
		{"textish exactly at the size cap", "exact.csv", maxSampleableFileBytes, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isSampleable(tc.path, tc.sizeBytes)
			if got != tc.want {
				t.Errorf("isSampleable(%q, %d) = %v, want %v", tc.path, tc.sizeBytes, got, tc.want)
			}
		})
	}
}
