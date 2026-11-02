use ostia_model::terminal::live_selection_store::{LiveSelectionSource, LiveSelectionStore};

fn editor_at(file: &str, start_line: u32, end_line: u32) -> LiveSelectionSource {
    LiveSelectionSource::Editor {
        file: file.to_owned(),
        start_line,
        end_line,
    }
}

#[test]
fn keeps_the_latest_selection_of_each_workspace_and_drops_it_when_its_pane_clears() {
    let mut store = LiveSelectionStore::default();
    assert!(store.report("w1", "p1", editor_at("/w/a.ts", 2, 4), "two\nthree\nfour"));
    assert!(store.report("w2", "p2", LiveSelectionSource::Terminal, "ls -la"));
    assert_eq!(
        store
            .of_workspace("w1")
            .map(|selection| selection.text.as_str()),
        Some("two\nthree\nfour")
    );
    assert_eq!(
        store
            .of_workspace("w2")
            .map(|selection| selection.source.clone()),
        Some(LiveSelectionSource::Terminal)
    );

    assert!(store.report("w1", "p1", editor_at("/w/a.ts", 2, 2), "   "));
    assert!(store.of_workspace("w1").is_none());
    assert!(store.clear("p2"));
    assert!(store.is_empty());
}

#[test]
fn clearing_a_pane_with_no_selection_changes_nothing() {
    let mut store = LiveSelectionStore::default();
    assert!(!store.clear("p1"));
    assert!(!store.report("w1", "p1", LiveSelectionSource::Terminal, "  "));
}
