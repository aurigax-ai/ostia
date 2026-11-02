#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use ostia_base::{Host, PaneId, Platform, WorkspaceId};
use ostia_git::workspace_cwds::{CwdPane, CwdWorkspace, WorkspaceCwds};

fn host() -> Host {
    Host {
        env: BTreeMap::new(),
        home: PathBuf::from("/home/u"),
        cwd: PathBuf::from("/"),
        platform: Platform::Linux,
    }
}

fn workspace(id: &str, work_dir: &str, active_pane_id: Option<&str>) -> CwdWorkspace {
    CwdWorkspace {
        workspace_id: WorkspaceId::new(id),
        work_dir: work_dir.to_owned(),
        active_pane_id: active_pane_id.map(PaneId::new),
    }
}

fn pane(pane_id: &str, workspace_id: &str, kind: &str, cwd: Option<&str>) -> CwdPane {
    CwdPane {
        pane_id: PaneId::new(pane_id),
        workspace_id: WorkspaceId::new(workspace_id),
        kind: kind.to_owned(),
        cwd: cwd.map(str::to_owned),
    }
}

fn expected(entries: &[(&str, &str)]) -> BTreeMap<WorkspaceId, PathBuf> {
    entries
        .iter()
        .map(|(id, cwd)| (WorkspaceId::new(*id), PathBuf::from(cwd)))
        .collect()
}

#[test]
fn uses_the_active_pane_cwd_of_each_workspace() {
    let cwds = WorkspaceCwds::new().resolve(
        &host(),
        &[
            workspace("s1", "/w1", Some("p2")),
            workspace("s2", "/w2", Some("p3")),
        ],
        &[
            pane("p1", "s1", "terminal", Some("/a")),
            pane("p2", "s1", "terminal", Some("/b")),
            pane("p3", "s2", "editor", Some("/c")),
        ],
    );
    assert_eq!(cwds, expected(&[("s1", "/b"), ("s2", "/c")]));
}

#[test]
fn falls_back_to_the_last_active_terminal_when_a_cwd_less_panel_is_focused() {
    let mut tracker = WorkspaceCwds::new();
    let panes = [
        pane("p1", "s1", "terminal", Some("/a")),
        pane("p2", "s1", "terminal", Some("/b")),
        pane("p3", "s1", "extension", None),
    ];
    tracker.resolve(&host(), &[workspace("s1", "/w", Some("p2"))], &panes);
    let cwds = tracker.resolve(&host(), &[workspace("s1", "/w", Some("p3"))], &panes);
    assert_eq!(
        cwds.get(&WorkspaceId::new("s1")),
        Some(&PathBuf::from("/b"))
    );
}

#[test]
fn falls_back_to_the_first_terminal_with_a_cwd_then_to_the_work_dir_with_home_expanded() {
    let host = host();
    let cwds = WorkspaceCwds::new().resolve(
        &host,
        &[
            workspace("s1", "/w", Some("p9")),
            workspace("s2", "~/proj", None),
        ],
        &[
            pane("p1", "s1", "extension", None),
            pane("p2", "s1", "terminal", Some("/t")),
        ],
    );
    assert_eq!(
        cwds.get(&WorkspaceId::new("s1")),
        Some(&PathBuf::from("/t"))
    );
    assert_eq!(
        cwds.get(&WorkspaceId::new("s2")),
        Some(&host.home.join("proj"))
    );
}
