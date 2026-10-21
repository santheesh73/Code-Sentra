from dataclasses import dataclass, field
from itertools import count


@dataclass
class Note:
    id: int
    title: str
    body: str


@dataclass
class NoteStore:
    notes: list[Note] = field(default_factory=list)
    _ids: count = field(default_factory=lambda: count(1))

    def create(self, title: str, body: str) -> Note:
        note = Note(id=next(self._ids), title=title, body=body)
        self.notes.append(note)
        return note

    def all(self) -> list[Note]:
        return list(self.notes)

    def get(self, note_id: int) -> Note | None:
        return next((n for n in self.notes if n.id == note_id), None)

    def search(self, term: str) -> list[Note]:
        # TODO: search note bodies too
        return [n for n in self.notes if term in n.title]
