use rs_notes_api::export;
use rs_notes_api::store::Store;

#[test]
fn adds_a_note() {
    let mut store = Store::new("x.json");
    assert_eq!(store.add("a", "b").id, 1);
}

#[test]
fn lists_notes() {
    let mut store = Store::new("x.json");
    store.add("a", "b");
    assert_eq!(store.all().len(), 1);
}

#[test]
#[ignore = "export is not built yet"]
fn exports_a_note_as_markdown() {
    let mut store = Store::new("x.json");
    let note = store.add("a", "b");
    assert!(export::markdown(&note).contains("# a"));
}

#[test]
fn searches_note_bodies() {
    let mut store = Store::new("x.json");
    store.add("groceries", "milk and eggs");
    assert_eq!(store.search("milk").len(), 1);
}
