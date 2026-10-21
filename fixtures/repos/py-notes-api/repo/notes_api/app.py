from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse
from jinja2 import Template
from pydantic import BaseModel

from notes_api import config
from notes_api.export import export_markdown
from notes_api.store import NoteStore

app = FastAPI(title="Notes API")
store = NoteStore()

INDEX = Template("<h1>Notes API</h1><p>{{ count }} notes stored in {{ db }}.</p>")


class NoteIn(BaseModel):
    title: str
    body: str = ""


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return INDEX.render(count=len(store.all()), db=config.DB_PATH)


@app.post("/notes", status_code=201)
def create_note(note: NoteIn) -> dict:
    return store.create(note.title, note.body).__dict__


@app.get("/notes")
def list_notes() -> list[dict]:
    return [n.__dict__ for n in store.all()]


@app.get("/notes/search")
def search_notes(q: str) -> list[dict]:
    return [n.__dict__ for n in store.search(q)]


@app.get("/notes/{note_id}/export.md", response_class=PlainTextResponse)
def export_note(note_id: int) -> str:
    note = store.get(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="note not found")
    return export_markdown(note)
