package com.example.shop;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
    public record CheckoutRequest(List<String> ids, String code) {}

    static int total(List<String> ids, String code) {
        // TODO: apply discount codes
        return ids.stream().mapToInt(id -> Catalog.find(id).map(Catalog.Product::cents).orElse(0)).sum();
    }

    @PostMapping("/api/checkout")
    public Map<String, Integer> checkout(
            @RequestHeader("X-Api-Key") String key, @RequestBody CheckoutRequest body) {
        if (!key.equals(Settings.apiKey())) throw new IllegalStateException("forbidden");
        return Map.of("total", total(body.ids(), body.code()));
    }

    @GetMapping("/api/orders/export.csv")
    public String exportCsv() {
        throw new UnsupportedOperationException("Not implemented yet");
    }
}
