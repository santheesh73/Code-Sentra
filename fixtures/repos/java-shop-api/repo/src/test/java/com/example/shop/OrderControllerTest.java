package com.example.shop;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

class OrderControllerTest {
    @Test
    void totalsProducts() {
        assertEquals(3700, OrderController.total(List.of("p1", "p2"), ""));
    }

    @Disabled("export is not built yet")
    @Test
    void exportsOrders() {
        assertEquals("id,total", new OrderController().exportCsv().lines().findFirst().orElse(""));
    }
}
