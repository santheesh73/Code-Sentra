package com.example.shop;

import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProductController {
    @GetMapping("/api/products")
    public List<Catalog.Product> list() {
        return Catalog.all();
    }

    @GetMapping("/api/products/{id}")
    public ResponseEntity<Catalog.Product> get(@PathVariable String id) {
        return Catalog.find(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }
}
