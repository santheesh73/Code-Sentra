<?php

declare(strict_types=1);

namespace App;

/** In-memory notes, persisted to a file path. */
final class Store
{
    /** @var list<array{id: int, title: string, body: string}> */
    private array $notes = [];

    public function __construct(public readonly string $path)
    {
    }

    public function add(string $title, string $body): array
    {
        $note = ['id' => count($this->notes) + 1, 'title' => $title, 'body' => $body];
        $this->notes[] = $note;
        return $note;
    }

    public function all(): array
    {
        return $this->notes;
    }

    public function find(int $id): ?array
    {
        foreach ($this->notes as $note) {
            if ($note['id'] === $id) {
                return $note;
            }
        }
        return null;
    }

    public function search(string $query): array
    {
        // TODO: search note bodies too
        return array_values(array_filter($this->notes, fn ($n) => str_contains($n['title'], $query)));
    }
}
