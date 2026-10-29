package catalog

import "testing"

func TestAllListsEveryProduct(t *testing.T) {
	if len(All()) != 2 {
		t.Fatalf("want 2 products, got %d", len(All()))
	}
}

func TestFindReturnsTheProduct(t *testing.T) {
	p, ok := Find("p2")
	if !ok || p.Name != "Poster" {
		t.Fatalf("got %+v, %v", p, ok)
	}
}
