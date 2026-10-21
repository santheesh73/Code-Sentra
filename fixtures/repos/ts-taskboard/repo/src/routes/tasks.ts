import { type Request, type Response, Router } from "express";
import { exportCsv } from "../lib/csv.ts";
import { TaskStore } from "../lib/store.ts";

export function tasksRouter(store: TaskStore = new TaskStore()): Router {
  const router = Router();

  router.post("/tasks", (req: Request, res: Response) => {
    const { title, assignee } = req.body as { title?: string; assignee?: string };
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    res.status(201).json(store.create(title, assignee ?? null));
  });

  router.get("/tasks", (_req: Request, res: Response) => {
    res.json(store.list());
  });

  router.patch("/tasks/:id/done", (req: Request, res: Response) => {
    const task = store.markDone(Number(req.params.id));
    if (!task) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(task);
  });

  router.get("/tasks/export.csv", (_req: Request, res: Response) => {
    res.type("text/csv").send(exportCsv(store.list()));
  });

  return router;
}
