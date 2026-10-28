package main

import (
	"log"
	"net/http"
	"os"

	"go-shop-api/internal/catalog"
	"go-shop-api/internal/orders"

	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	r.Get("/products", catalog.List)
	r.Get("/products/{id}", catalog.Get)
	r.Post("/checkout", orders.Checkout)
	r.Get("/orders/export.csv", orders.ExportCSV)

	addr := os.Getenv("SHOP_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Fatal(http.ListenAndServe(addr, r))
}
