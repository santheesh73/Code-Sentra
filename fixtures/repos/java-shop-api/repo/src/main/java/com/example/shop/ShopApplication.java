package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShopApplication {
    public static void main(String[] args) {
        System.setProperty("server.port", Settings.port());
        SpringApplication.run(ShopApplication.class, args);
    }
}
