package drives

import "testing"

func TestRootsKeepsOrder(t *testing.T) {
	got := Roots([]Volume{{Root: `C:\`, Kind: Fixed}, {Root: `E:\`, Kind: Removable}})
	if len(got) != 2 || got[0] != `C:\` || got[1] != `E:\` {
		t.Fatalf("got %v", got)
	}
}

func TestRootsOfNothingIsEmptyNotNil(t *testing.T) {
	if got := Roots(nil); got == nil || len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}
