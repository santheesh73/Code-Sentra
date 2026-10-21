import sortBy from "lodash/sortBy.js";

export interface Task {
  id: number;
  title: string;
  assignee: string | null;
  done: boolean;
  createdAt: number;
}

export class TaskStore {
  private tasks: Task[] = [];
  private nextId = 1;

  create(title: string, assignee: string | null): Task {
    const task: Task = { id: this.nextId++, title, assignee, done: false, createdAt: Date.now() };
    this.tasks.push(task);
    return task;
  }

  list(): Task[] {
    return sortBy(this.tasks, (t) => -t.createdAt);
  }

  get(id: number): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  markDone(id: number): Task | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    // TODO: persist the completion timestamp
    task.done = task.assignee !== null;
    return task;
  }
}
