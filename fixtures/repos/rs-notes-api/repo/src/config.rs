//! Settings from the environment.
use std::env;

pub fn db_path() -> String {
    env::var("NOTES_DB_PATH").unwrap_or_else(|_| "notes.json".to_string())
}

pub fn signing_key() -> Option<String> {
    env::var("NOTES_SIGNING_KEY").ok()
}
