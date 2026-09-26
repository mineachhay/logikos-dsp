package buildinfo

import "testing"

func TestFormat(t *testing.T) {
	cases := []struct {
		rev      string
		modified bool
		want     string
	}{
		{"3bdf58922755645fbfcb1744fe2939419b887644", false, "3bdf58922755"},
		{"3bdf58922755645fbfcb1744fe2939419b887644", true, "3bdf58922755-dirty"},
		{"", false, ""},
		{"abc", false, ""},
	}
	for _, c := range cases {
		if got := Format(c.rev, c.modified); got != c.want {
			t.Errorf("Format(%q, %v) = %q, want %q", c.rev, c.modified, got, c.want)
		}
	}
}
