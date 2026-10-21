import express, { type NextFunction, type Request, type Response } from "express";
import { tasksRouter } from "./routes/tasks.ts";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const adminToken = process.env.TASKBOARD_ADMIN_TOKEN;
    if (req.method !== "GET" && adminToken && req.header("x-admin-token") !== adminToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.use(tasksRouter());
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`taskboard listening on ${port}`));
}
