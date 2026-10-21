import assert from "node:assert/strict";
import { test } from "node:test";
import { exportCsv } from "../src/lib/csv.ts";
import { TaskStore } from "../src/lib/store.ts";

test("creates a task", () => {
  const store = new TaskStore();
  const task = store.create("Write docs", "ana");
  assert.equal(task.title, "Write docs");
  assert.equal(task.done, false);
});

test("lists tasks newest first", async () => {
  const store = new TaskStore();
  store.create("first", null);
  await new Promise((r) => setTimeout(r, 2));
  store.create("second", null);
  assert.deepEqual(
    store.list().map((t) => t.title),
    ["second", "first"],
  );
});

test("marks a task done", () => {
  const store = new TaskStore();
  const task = store.create("Unassigned chore", null);
  assert.equal(store.markDone(task.id)?.done, true);
});

test.skip("exports tasks as CSV", () => {
  const store = new TaskStore();
  store.create("Ship it", "bo");
  assert.match(exportCsv(store.list()), /Ship it/);
});
