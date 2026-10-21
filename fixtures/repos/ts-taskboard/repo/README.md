# Taskboard

A tiny HTTP API for team task lists. Teams use it to track who is doing what
without a heavyweight project tool.

## Features

- **Create tasks** — `POST /tasks` with a title and optional assignee.
- **List tasks** — `GET /tasks` returns every task, newest first.
- **Mark tasks done** — `PATCH /tasks/:id/done` marks a task complete.
- **Export tasks to CSV** — `GET /tasks/export.csv` downloads all tasks.

## Roadmap

- **Email reminders** — daily email to assignees with their open tasks.

## Setup

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

Configuration is read from the environment; see `.env.example`.

## Tests

```sh
npm test
```
