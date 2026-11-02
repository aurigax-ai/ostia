#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ostia_browser::browser_profile::{BrowserProfile, SHARED_BROWSER_PARTITION};
use ostia_browser::browser_profiles::{BrowserPaneOwner, BrowserProfiles, BrowserProfilesDeps};
use parking_lot::Mutex;
use serde_json::{Value, json};

struct World {
    owners: Arc<Mutex<HashMap<String, BrowserPaneOwner>>>,
    scratch: Arc<Mutex<HashSet<String>>>,
    sandboxed: Arc<Mutex<HashSet<String>>>,
    profiles: BrowserProfiles,
}

fn owner(window: &str, workspace: &str) -> BrowserPaneOwner {
    BrowserPaneOwner {
        window_id: window.to_owned(),
        workspace_id: workspace.to_owned(),
    }
}

fn world() -> World {
    let owners = Arc::new(Mutex::new(HashMap::from([
        ("p1".to_owned(), owner("w1", "ws")),
        ("p2".to_owned(), owner("w1", "ws")),
        ("scratch-pane".to_owned(), owner("w1", "scratch-ws")),
        ("sandbox-pane".to_owned(), owner("w1", "sandbox-ws")),
    ])));
    let scratch = Arc::new(Mutex::new(HashSet::from(["scratch-ws".to_owned()])));
    let sandboxed = Arc::new(Mutex::new(HashSet::from(["sandbox-ws".to_owned()])));
    let profiles = BrowserProfiles::new(BrowserProfilesDeps {
        owner_of: {
            let owners = owners.clone();
            Arc::new(move |pane| owners.lock().get(pane).cloned())
        },
        is_scratch: {
            let scratch = scratch.clone();
            Arc::new(move |ws| scratch.lock().contains(ws))
        },
        is_sandboxed: {
            let sandboxed = sandboxed.clone();
            Arc::new(move |ws| sandboxed.lock().contains(ws))
        },
    });
    World {
        owners,
        scratch,
        sandboxed,
        profiles,
    }
}

fn claim(w: &World, pane: &str, window: &str, requested: &str) -> BrowserProfile {
    w.profiles.claim(&json!(pane), window, &json!(requested))
}

#[test]
fn grants_the_shared_profile_to_a_pane_the_window_owns_in_an_ordinary_workspace() {
    let w = world();
    assert_eq!(claim(&w, "p1", "w1", "shared"), BrowserProfile::Shared);
    assert!(w.profiles.is_shared("p1"));
}

#[test]
fn grants_isolated_when_isolated_is_asked_for() {
    let w = world();
    assert_eq!(claim(&w, "p1", "w1", "isolated"), BrowserProfile::Isolated);
    assert!(!w.profiles.is_shared("p1"));
}

#[test]
fn refuses_the_shared_profile_in_a_scratch_or_sandboxed_workspace() {
    let w = world();
    assert_eq!(
        claim(&w, "scratch-pane", "w1", "shared"),
        BrowserProfile::Isolated
    );
    assert_eq!(
        claim(&w, "sandbox-pane", "w1", "shared"),
        BrowserProfile::Isolated
    );
}

#[test]
fn refuses_the_shared_profile_to_a_window_that_does_not_own_the_pane_or_an_unknown_pane() {
    let w = world();
    assert_eq!(claim(&w, "p1", "w2", "shared"), BrowserProfile::Isolated);
    assert_eq!(claim(&w, "ghost", "w1", "shared"), BrowserProfile::Isolated);
    assert_eq!(
        w.profiles.claim(&json!(42), "w1", &json!("shared")),
        BrowserProfile::Isolated
    );
}

#[test]
fn never_turns_a_pane_that_started_isolated_into_a_shared_one() {
    let w = world();
    claim(&w, "p1", "w1", "isolated");
    assert_eq!(claim(&w, "p1", "w1", "shared"), BrowserProfile::Isolated);
}

#[test]
fn drops_a_shared_pane_to_isolated_once_its_workspace_is_sandboxed() {
    let w = world();
    claim(&w, "p1", "w1", "shared");
    w.sandboxed.lock().insert("ws".to_owned());
    assert_eq!(claim(&w, "p1", "w1", "shared"), BrowserProfile::Isolated);
    w.sandboxed.lock().remove("ws");
    assert_eq!(claim(&w, "p1", "w1", "shared"), BrowserProfile::Isolated);
}

#[test]
fn keeps_a_shared_pane_shared_when_it_moves_to_another_window() {
    let w = world();
    claim(&w, "p1", "w1", "shared");
    w.owners.lock().insert("p1".to_owned(), owner("w2", "ws"));
    assert_eq!(claim(&w, "p1", "w1", "shared"), BrowserProfile::Isolated);
    assert_eq!(claim(&w, "p1", "w2", "shared"), BrowserProfile::Shared);
}

#[test]
fn keeps_an_isolated_pane_isolated_when_it_moves_to_another_window() {
    let w = world();
    claim(&w, "p1", "w1", "isolated");
    w.owners.lock().insert("p1".to_owned(), owner("w2", "ws"));
    assert_eq!(claim(&w, "p1", "w2", "shared"), BrowserProfile::Isolated);
}

#[test]
fn forgets_a_closed_pane() {
    let w = world();
    claim(&w, "p1", "w1", "shared");
    w.profiles.forget("p1");
    assert!(!w.profiles.is_shared("p1"));
    assert!(
        !w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w1")
    );
}

#[test]
fn accepts_an_isolated_pane_partition() {
    let w = world();
    assert!(w.profiles.accepts_attach(Some("ostia-browser-p1"), "w1"));
}

#[test]
fn refuses_any_other_partition() {
    let w = world();
    for partition in [Some("ostia-ext-git"), Some("persist:other"), Some(""), None] {
        assert!(
            !w.profiles.accepts_attach(partition, "w1"),
            "partition {partition:?}"
        );
    }
}

#[test]
fn refuses_the_shared_partition_when_no_pane_of_that_window_was_granted_it() {
    let w = world();
    assert!(
        !w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w1")
    );
    claim(&w, "p1", "w1", "isolated");
    assert!(
        !w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w1")
    );
}

#[test]
fn accepts_the_shared_partition_only_from_a_window_holding_a_granted_pane_again_on_re_attach() {
    let w = world();
    claim(&w, "p1", "w1", "shared");
    assert!(
        !w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w2")
    );
    assert!(
        w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w1")
    );
    assert!(
        w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w1")
    );
}

#[test]
fn stops_accepting_the_shared_partition_once_the_window_gives_the_pane_away() {
    let w = world();
    claim(&w, "p1", "w1", "shared");
    w.owners.lock().insert("p1".to_owned(), owner("w2", "ws"));
    assert!(
        !w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w1")
    );
    assert!(
        w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w2")
    );
}

#[test]
fn refuses_the_shared_partition_when_the_workspace_became_sandboxed_after_the_claim() {
    let w = world();
    claim(&w, "p1", "w1", "shared");
    w.sandboxed.lock().insert("ws".to_owned());
    assert!(
        !w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w1")
    );
}

#[test]
fn refuses_the_shared_partition_when_the_workspace_became_scratch_after_the_claim() {
    let w = world();
    claim(&w, "p1", "w1", "shared");
    w.scratch.lock().insert("ws".to_owned());
    assert!(
        !w.profiles
            .accepts_attach(Some(SHARED_BROWSER_PARTITION), "w1")
    );
}

#[test]
fn gives_isolated_for_an_empty_or_non_string_pane_id_and_for_a_request_that_is_not_shared() {
    let w = world();
    for pane in [json!(""), Value::Null, json!(7), json!(["p1"])] {
        assert_eq!(
            w.profiles.claim(&pane, "w1", &json!("shared")),
            BrowserProfile::Isolated,
            "pane {pane}"
        );
    }
    for requested in [Value::Null, json!(true), json!("Shared"), json!("")] {
        assert_eq!(
            w.profiles.claim(&json!("p2"), "w1", &requested),
            BrowserProfile::Isolated,
            "requested {requested}"
        );
    }
}

#[test]
fn reports_isolated_for_a_pane_never_claimed_and_refuses_a_pane_whose_owner_has_no_workspace() {
    let w = world();
    assert_eq!(w.profiles.profile_of("never"), BrowserProfile::Isolated);
    w.owners.lock().insert("bare".to_owned(), owner("w1", ""));
    assert_eq!(claim(&w, "bare", "w1", "shared"), BrowserProfile::Isolated);
}
