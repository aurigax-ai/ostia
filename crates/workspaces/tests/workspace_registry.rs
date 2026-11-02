#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::thread;

use ostia_workspaces::workspace_registry::WorkspaceRegistry;

#[test]
fn stores_the_work_folder_of_a_workspace_and_reads_it_back() {
    let registry = WorkspaceRegistry::default();
    registry.set_work_dir("w1", "/home/u/api", None);
    assert_eq!(
        registry.work_dir_for(Some("w1")),
        Some("/home/u/api".to_owned())
    );
}

#[test]
fn a_new_work_folder_replaces_the_old_one() {
    let registry = WorkspaceRegistry::default();
    registry.set_work_dir("w1", "/home/u/api", None);
    registry.set_work_dir("w1", "/home/u/web", None);
    assert_eq!(
        registry.work_dir_for(Some("w1")),
        Some("/home/u/web".to_owned())
    );
}

#[test]
fn has_no_work_folder_for_an_unknown_or_missing_workspace_id() {
    let registry = WorkspaceRegistry::default();
    registry.set_work_dir("w1", "/home/u/api", None);
    assert_eq!(registry.work_dir_for(Some("w2")), None);
    assert_eq!(registry.work_dir_for(None), None);
}

#[test]
fn treats_an_empty_workspace_id_as_missing_when_it_reads() {
    let registry = WorkspaceRegistry::default();
    registry.set_work_dir("", "/home/u/api", None);
    assert_eq!(registry.work_dir_for(Some("")), None);
    assert_eq!(registry.known(), vec![String::new()]);
}

#[test]
fn records_the_window_only_when_a_window_id_is_given() {
    let registry = WorkspaceRegistry::default();
    registry.set_work_dir("w1", "/home/u/api", Some("7"));
    registry.set_work_dir("w2", "/home/u/web", None);
    registry.set_work_dir("w3", "/home/u/db", Some(""));
    assert_eq!(registry.window_for("w1"), Some("7".to_owned()));
    assert_eq!(registry.window_for("w2"), None);
    assert_eq!(registry.window_for("w3"), None);
}

#[test]
fn keeps_the_window_when_a_later_set_gives_none_and_replaces_it_when_it_gives_another() {
    let registry = WorkspaceRegistry::default();
    registry.set_work_dir("w1", "/home/u/api", Some("7"));
    registry.set_work_dir("w1", "/home/u/web", None);
    assert_eq!(registry.window_for("w1"), Some("7".to_owned()));
    registry.set_work_dir("w1", "/home/u/web", Some(""));
    assert_eq!(registry.window_for("w1"), Some("7".to_owned()));
    registry.set_work_dir("w1", "/home/u/web", Some("9"));
    assert_eq!(registry.window_for("w1"), Some("9".to_owned()));
}

#[test]
fn removing_a_workspace_clears_its_work_folder_and_its_window() {
    let registry = WorkspaceRegistry::default();
    registry.set_work_dir("w1", "/home/u/api", Some("7"));
    registry.set_work_dir("w2", "/home/u/web", Some("7"));
    registry.remove("w1");
    assert_eq!(registry.work_dir_for(Some("w1")), None);
    assert_eq!(registry.window_for("w1"), None);
    assert_eq!(
        registry.work_dir_for(Some("w2")),
        Some("/home/u/web".to_owned())
    );
    assert_eq!(registry.window_for("w2"), Some("7".to_owned()));
}

#[test]
fn removing_an_unknown_workspace_changes_nothing() {
    let registry = WorkspaceRegistry::default();
    registry.set_work_dir("w1", "/home/u/api", Some("7"));
    registry.remove("ghost");
    assert_eq!(registry.known(), vec!["w1".to_owned()]);
    assert_eq!(registry.window_for("w1"), Some("7".to_owned()));
}

#[test]
fn lists_known_workspaces_in_the_order_they_were_first_set() {
    let registry = WorkspaceRegistry::default();
    assert_eq!(registry.known(), Vec::<String>::new());
    registry.set_work_dir("b", "/b", None);
    registry.set_work_dir("a", "/a", None);
    registry.set_work_dir("c", "/c", None);
    registry.set_work_dir("a", "/a2", None);
    assert_eq!(
        registry.known(),
        vec!["b".to_owned(), "a".to_owned(), "c".to_owned()]
    );
    registry.remove("b");
    registry.set_work_dir("b", "/b", None);
    assert_eq!(
        registry.known(),
        vec!["a".to_owned(), "c".to_owned(), "b".to_owned()]
    );
}

#[test]
fn clones_share_one_state() {
    let registry = WorkspaceRegistry::default();
    let other = registry.clone();
    other.set_work_dir("w1", "/home/u/api", Some("7"));
    assert_eq!(
        registry.work_dir_for(Some("w1")),
        Some("/home/u/api".to_owned())
    );
    registry.remove("w1");
    assert_eq!(other.known(), Vec::<String>::new());
}

#[test]
fn keeps_every_workspace_that_threads_set_at_the_same_time() {
    let registry = WorkspaceRegistry::default();
    let workers: Vec<_> = (0..8)
        .map(|worker| {
            let registry = registry.clone();
            thread::spawn(move || {
                for index in 0..50 {
                    registry.set_work_dir(&format!("w{worker}-{index}"), "/work", Some("7"));
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(registry.known().len(), 400);
    assert_eq!(registry.window_for("w7-49"), Some("7".to_owned()));
}
