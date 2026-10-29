<?php

declare(strict_types=1);

namespace App;

/** Settings from the environment. */
final class Config
{
    public static function dbPath(): string
    {
        return getenv('NOTES_DB_PATH') ?: 'notes.json';
    }

    public static function signingKey(): ?string
    {
        return $_ENV['NOTES_SIGNING_KEY'] ?? null;
    }
}
