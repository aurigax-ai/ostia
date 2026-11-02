#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_sandbox::attach_workspace::{AttachWorkspace, attach_workspace};

fn attached(id: &str) -> AttachWorkspace {
    AttachWorkspace::Attached(id.to_owned())
}

#[test]
fn sbx_c13_refuses_an_attach_that_names_another_workspace_than_the_pane_is_registered_in() {
    assert_eq!(
        attach_workspace(Some("ws-a"), "ws-b"),
        AttachWorkspace::Refused
    );
}

#[test]
fn sbx_c14_takes_the_workspace_from_the_attach_when_pane_created_has_not_arrived_yet() {
    assert_eq!(attach_workspace(None, "ws-a"), attached("ws-a"));
    assert_eq!(attach_workspace(Some(""), "ws-a"), attached("ws-a"));
    assert_eq!(attach_workspace(Some("ws-a"), "ws-a"), attached("ws-a"));
    assert_eq!(attach_workspace(Some("ws-a"), ""), attached("ws-a"));
}

#[test]
fn takes_an_empty_workspace_when_neither_side_names_one() {
    assert_eq!(attach_workspace(None, ""), attached(""));
    assert_eq!(attach_workspace(Some(""), ""), attached(""));
}
