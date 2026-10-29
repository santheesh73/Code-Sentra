#[tokio::main]
async fn main() {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("port 3000 is in use");
    axum::serve(listener, rs_notes_api::app())
        .await
        .expect("server stopped");
}
