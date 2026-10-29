//! In-memory notes, persisted to a file path.
use smallvec::SmallVec;

#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub id: u32,
    pub title: String,
    pub body: String,
}

pub struct Store {
    pub path: String,
    notes: SmallVec<[Note; 8]>,
}

impl Store {
    pub fn new(path: &str) -> Self {
        Store { path: path.to_string(), notes: SmallVec::new() }
    }

    pub fn add(&mut self, title: &str, body: &str) -> Note {
        let note = Note { id: self.notes.len() as u32 + 1, title: title.into(), body: body.into() };
        self.notes.push(note.clone());
        note
    }

    pub fn all(&self) -> &[Note] {
        &self.notes
    }

    pub fn find(&self, id: u32) -> Option<&Note> {
        self.notes.iter().find(|n| n.id == id)
    }

    pub fn search(&self, query: &str) -> Vec<&Note> {
        // TODO: search note bodies too
        self.notes.iter().filter(|n| n.title.contains(query)).collect()
    }
}
