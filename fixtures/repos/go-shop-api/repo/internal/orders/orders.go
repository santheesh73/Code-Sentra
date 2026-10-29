// Package orders handles checkout.
package orders

import (
	"encoding/json"
	"net/http"
	"os"

	"go-shop-api/internal/catalog"
)

// Total sums the cents of the given product ids, applying the discount code.
func Total(ids []string, code string) int {
	sum := 0
	for _, id := range ids {
		if p, ok := catalog.Find(id); ok {
			sum += p.Cents
		}
	}
	// TODO: apply discount codes
	_ = code
	return sum
}

// Checkout handles POST /checkout.
func Checkout(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Api-Key") != os.Getenv("SHOP_API_KEY") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		IDs  []string `json:"ids"`
		Code string   `json:"code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	_ = json.NewEncoder(w).Encode(map[string]int{"total": Total(body.IDs, body.Code)})
}

// ExportCSV handles GET /orders/export.csv.
func ExportCSV(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/csv")
	_, _ = w.Write([]byte(exportOrders()))
}

func exportOrders() string {
	panic("not implemented")
}
