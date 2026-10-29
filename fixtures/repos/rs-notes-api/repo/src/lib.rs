//! The notes HTTP API.
pub mod config;
pub mod defaults;
pub mod export;
pub mod store;

use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::Router;
use std::collections::HashMap;

pub fn app() -> Router {
    Router::new()
        .route("/notes", get(list).post(create))
        .route("/notes/search", get(search))
        .route("/notes/:id/export.md", get(export_note))
}

async fn list() -> String {
    format!("{} notes", store::Store::new(&config::db_path()).all().len())
}

async fn create(headers: HeaderMap) -> StatusCode {
    let signature = headers.get("x-signature").and_then(|v| v.to_str().ok());
    if signature != config::signing_key().as_deref() {
        return StatusCode::FORBIDDEN;
    }
    StatusCode::CREATED
}

async fn search(Query(params): Query<HashMap<String, String>>) -> String {
    let store = store::Store::new(&config::db_path());
    let query = params.get("q").cloned().unwrap_or_default();
    format!("{} matches", store.search(&query).len())
}

async fn export_note(Path(id): Path<u32>) -> String {
    let store = store::Store::new(&config::db_path());
    store.find(id).map(export::markdown).unwrap_or_default()
}
