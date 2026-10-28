package com.example.shop;

import java.util.List;
import java.util.Optional;

/** The products for sale. */
public final class Catalog {
    public record Product(String id, String name, int cents) {}

    private static final List<Product> PRODUCTS =
        List.of(new Product("p1", "Mug", 1200), new Product("p2", "Poster", 2500));

    public static List<Product> all() {
        return PRODUCTS;
    }

    public static Optional<Product> find(String id) {
        return PRODUCTS.stream().filter(p -> p.id().equals(id)).findFirst();
    }
}
