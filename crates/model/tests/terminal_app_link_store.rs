#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::terminal::app_link_store::{AppLinkPrompt, AppLinkStore};

fn ask(url: &str, app: &str) -> AppLinkPrompt {
    AppLinkPrompt::Ask {
        url: url.to_owned(),
        app: app.to_owned(),
    }
}

#[test]
fn shows_a_prompt_for_one_pane_and_replaces_it_on_the_next_show() {
    let mut store = AppLinkStore::default();
    assert!(store.of_pane("p1").is_none());

    store.show("p1", ask("zoommtg://a", "Zoom"));
    assert_eq!(store.of_pane("p1"), Some(&ask("zoommtg://a", "Zoom")));
    assert!(store.of_pane("p2").is_none());

    let failed = AppLinkPrompt::Failed {
        url: "zoommtg://a".to_owned(),
        app: "Zoom".to_owned(),
    };
    store.show("p1", failed.clone());
    assert_eq!(store.of_pane("p1"), Some(&failed));

    let none = AppLinkPrompt::NoApp {
        url: "foo://b".to_owned(),
    };
    store.show("p2", none.clone());
    assert_eq!(store.of_pane("p2"), Some(&none));
    assert_eq!(store.of_pane("p1"), Some(&failed));
}

#[test]
fn release_drops_the_prompt_once_and_changes_nothing_for_a_pane_without_one() {
    let mut store = AppLinkStore::default();
    assert!(!store.release("p1"));

    store.show("p1", ask("zoommtg://a", "Zoom"));
    store.show("p2", ask("zoommtg://b", "Zoom"));
    assert!(store.release("p1"));
    assert!(store.of_pane("p1").is_none());
    assert!(!store.release("p1"));
    assert_eq!(store.of_pane("p2"), Some(&ask("zoommtg://b", "Zoom")));
}
