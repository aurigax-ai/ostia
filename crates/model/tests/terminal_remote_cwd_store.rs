use ostia_contract::remote_folders::RemoteCwd;
use ostia_model::terminal::remote_cwd_store::RemoteCwdStore;

fn remote(host: &str, cwd: &str) -> RemoteCwd {
    RemoteCwd {
        host: host.to_owned(),
        cwd: cwd.to_owned(),
    }
}

#[test]
fn keeps_the_report_and_changes_nothing_for_the_same_one() {
    let mut store = RemoteCwdStore::default();
    assert!(store.report("p1", Some(remote("box", "/srv"))));
    assert!(!store.report("p1", Some(remote("box", "/srv"))));
    assert_eq!(store.of_pane("p1"), Some(&remote("box", "/srv")));
    assert!(store.report("p1", Some(remote("box", "/tmp"))));
}

#[test]
fn a_report_of_none_drops_the_pane_once() {
    let mut store = RemoteCwdStore::default();
    assert!(!store.report("p1", None));
    assert!(store.report("p1", Some(remote("box", "/srv"))));
    assert!(store.report("p1", None));
    assert!(store.of_pane("p1").is_none());
}
