<?php

declare(strict_types=1);

namespace Tests;

use App\Export;
use App\Store;
use PHPUnit\Framework\TestCase;

final class StoreTest extends TestCase
{
    public function testAddsANote(): void
    {
        $store = new Store('x.json');
        $this->assertSame(1, $store->add('a', 'b')['id']);
    }

    public function testListsNotes(): void
    {
        $store = new Store('x.json');
        $store->add('a', 'b');
        $this->assertCount(1, $store->all());
    }

    public function testExportsANoteAsMarkdown(): void
    {
        $this->markTestSkipped('export is not built yet');
        $this->assertStringContainsString('# a', Export::markdown(['id' => 1, 'title' => 'a', 'body' => 'b']));
    }

    public function testSearchesNoteBodies(): void
    {
        $store = new Store('x.json');
        $store->add('groceries', 'milk and eggs');
        $this->assertCount(1, $store->search('milk'));
    }
}
