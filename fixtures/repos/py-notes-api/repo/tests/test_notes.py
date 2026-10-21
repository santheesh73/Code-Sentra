import pytest
from fastapi.testclient import TestClient

from notes_api.app import app, store


@pytest.fixture(autouse=True)
def clean_store():
    store.notes.clear()
    yield


client = TestClient(app)


def test_create_note():
    res = client.post("/notes", json={"title": "Groceries", "body": "milk"})
    assert res.status_code == 201
    assert res.json()["title"] == "Groceries"


def test_list_notes():
    client.post("/notes", json={"title": "a"})
    client.post("/notes", json={"title": "b"})
    assert [n["title"] for n in client.get("/notes").json()] == ["a", "b"]


def test_search_is_case_insensitive():
    client.post("/notes", json={"title": "Groceries"})
    assert len(client.get("/notes/search", params={"q": "groceries"}).json()) == 1


@pytest.mark.skip(reason="markdown export not built yet")
def test_export_markdown():
    note = client.post("/notes", json={"title": "Ideas", "body": "x"}).json()
    assert client.get(f"/notes/{note['id']}/export.md").text.startswith("# Ideas")
