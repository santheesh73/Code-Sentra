package com.example.shop;

/** Settings read from the environment. */
public final class Settings {
    private Settings() {}

    public static String port() {
        String p = System.getenv("SHOP_PORT");
        return p == null ? "8080" : p;
    }

    public static String apiKey() {
        return System.getenv("SHOP_API_KEY");
    }
}
