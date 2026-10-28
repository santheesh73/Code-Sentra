// Package catalog serves the product list.
package catalog

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Product is one item for sale.
type Product struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Cents int    `json:"cents"`
}

var products = []Product{
	{ID: "p1", Name: "Mug", Cents: 1200},
	{ID: "p2", Name: "Poster", Cents: 2500},
}

// All returns every product.
func All() []Product { return products }

// Find returns the product with the id, or false.
func Find(id string) (Product, bool) {
	for _, p := range products {
		if p.ID == id {
			return p, true
		}
	}
	return Product{}, false
}

// List handles GET /products.
func List(w http.ResponseWriter, _ *http.Request) {
	_ = json.NewEncoder(w).Encode(All())
}

// Get handles GET /products/{id}.
func Get(w http.ResponseWriter, r *http.Request) {
	p, ok := Find(chi.URLParam(r, "id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	_ = json.NewEncoder(w).Encode(p)
}
