package orders

import "testing"

func TestTotalSumsProducts(t *testing.T) {
	if got := Total([]string{"p1", "p2"}, ""); got != 3700 {
		t.Fatalf("want 3700, got %d", got)
	}
}

func TestTotalAppliesDiscount(t *testing.T) {
	if got := Total([]string{"p1"}, "HALF"); got != 600 {
		t.Fatalf("want 600, got %d", got)
	}
}

func TestExportOrders(t *testing.T) {
	t.Skip("export is not built yet")
}
