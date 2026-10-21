# Notes API

A small FastAPI service for personal notes. It gives scripts and small apps a
place to store and find short notes over HTTP.

## Features

- **Create notes** — `POST /notes` with a title and body.
- **List notes** — `GET /notes` returns all notes.
- **Search notes** — `GET /notes/search?q=term` finds notes by title, case-insensitively.
- **Export a note as Markdown** — `GET /notes/{id}/export.md`.

## Roadmap

- **Share notes via link** — public read-only links for a single note.

## Setup

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env
uvicorn notes_api.app:app --reload
```

## Tests

```sh
pytest
```
