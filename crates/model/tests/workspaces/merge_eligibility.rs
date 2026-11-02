#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::sandbox::WorkspaceSandbox;
use ostia_model::sidebar::group_peers::WorkspaceKind;
use ostia_model::workspaces::merge_eligibility::{
    MergeOption, MergeOptionRefusal, MergeRefusal, MergeSide, PathOwner, infer_home, merge_options,
    merge_refusal, workspace_path,
};
use serde_json::json;

const HOME: Option<&str> = Some("/home/u");

fn owner(work_dir: &str, project_dir: Option<&str>) -> PathOwner {
    PathOwner {
        work_dir: work_dir.to_owned(),
        project_dir: project_dir.map(str::to_owned),
    }
}

fn side(id: &str) -> MergeSide {
    MergeSide {
        id: id.to_owned(),
        kind: WorkspaceKind::Terminal,
        work_dir: "/home/u/proj".to_owned(),
        project_dir: None,
        window_id: Some("win1".to_owned()),
        sandbox: None,
    }
}

fn in_dir(id: &str, work_dir: &str) -> MergeSide {
    MergeSide {
        work_dir: work_dir.to_owned(),
        ..side(id)
    }
}

fn in_window(id: &str, window_id: &str) -> MergeSide {
    MergeSide {
        window_id: Some(window_id.to_owned()),
        ..side(id)
    }
}

fn of_kind(id: &str, kind: WorkspaceKind) -> MergeSide {
    MergeSide { kind, ..side(id) }
}

fn sandbox() -> WorkspaceSandbox {
    WorkspaceSandbox {
        enabled: true,
        ..WorkspaceSandbox::empty()
    }
}

fn with_sandbox(id: &str, sandbox: WorkspaceSandbox) -> MergeSide {
    MergeSide {
        sandbox: Some(sandbox),
        ..side(id)
    }
}

fn browser_allowlist() -> serde_json::Map<String, serde_json::Value> {
    json!({"browser": "allowlist"}).as_object().unwrap().clone()
}

fn domains(list: &[&str]) -> Vec<String> {
    list.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn prefers_the_project_folder_over_the_work_folder() {
    assert_eq!(
        workspace_path(&owner("/home/u/proj/src", Some("~/proj")), HOME),
        "/home/u/proj"
    );
}

#[test]
fn drops_trailing_slashes_and_resolves_dot_segments() {
    assert_eq!(
        workspace_path(&owner("/home/u/proj/", None), HOME),
        "/home/u/proj"
    );
    assert_eq!(
        workspace_path(&owner("/home/u/x/../proj/.", None), HOME),
        "/home/u/proj"
    );
}

#[test]
fn expands_tilde_when_the_home_folder_is_known_and_keeps_it_otherwise() {
    assert_eq!(workspace_path(&owner("~/proj", None), HOME), "/home/u/proj");
    assert_eq!(workspace_path(&owner("~", None), HOME), "/home/u");
    assert_eq!(workspace_path(&owner("~/proj/", None), None), "~/proj");
}

#[test]
fn falls_back_to_the_work_folder_for_a_blank_project_folder_and_trims_both() {
    assert_eq!(
        workspace_path(&owner("  /home/u/proj  ", Some("   ")), HOME),
        "/home/u/proj"
    );
    assert_eq!(
        workspace_path(&owner("/elsewhere", Some("  ~/proj ")), HOME),
        "/home/u/proj"
    );
    assert_eq!(
        workspace_path(&owner("/elsewhere", Some("")), HOME),
        "/elsewhere"
    );
}

#[test]
fn ignores_dot_dot_segments_that_climb_past_the_start() {
    assert_eq!(workspace_path(&owner("/a/../../b", None), HOME), "/b");
    assert_eq!(workspace_path(&owner("a/../../b", None), HOME), "b");
    assert_eq!(workspace_path(&owner("~/../x", None), None), "~/x");
    assert_eq!(workspace_path(&owner("/", None), HOME), "/");
}

#[test]
fn reads_the_home_folder_off_a_workspace_whose_project_is_shown_under_tilde() {
    assert_eq!(
        infer_home(&[owner("/home/u/proj", Some("~/proj"))]),
        Some("/home/u".to_owned())
    );
    assert_eq!(
        infer_home(&[owner("/home/u", Some("~"))]),
        Some("/home/u".to_owned())
    );
}

#[test]
fn returns_null_when_no_workspace_shows_a_project_under_tilde() {
    assert_eq!(
        infer_home(&[owner("/srv/app", None), owner("/srv/x", Some("/srv/x")),]),
        None
    );
}

#[test]
fn skips_a_workspace_whose_folders_do_not_agree_and_reads_the_next_one() {
    assert_eq!(
        infer_home(&[
            owner("/srv/app", Some("~/proj")),
            owner("rel/proj", Some("~/proj")),
            owner("/home/u/proj", Some("~/proj")),
        ]),
        Some("/home/u".to_owned())
    );
}

#[test]
fn does_not_take_the_root_folder_as_a_home_folder() {
    assert_eq!(infer_home(&[owner("/proj", Some("~/proj"))]), None);
}

#[test]
fn allows_two_workspaces_of_one_window_in_the_same_folder() {
    assert_eq!(merge_refusal(&side("a"), &side("b"), HOME), None);
}

#[test]
fn matches_a_tilde_project_against_the_same_absolute_folder() {
    let source = in_dir("a", "~/proj");
    let target = MergeSide {
        project_dir: Some("~/proj".to_owned()),
        ..in_dir("b", "/home/u/proj/")
    };
    assert_eq!(merge_refusal(&source, &target, HOME), None);
}

#[test]
fn refuses_a_workspace_in_another_folder() {
    assert_eq!(
        merge_refusal(&side("a"), &in_dir("b", "/home/u/other"), HOME),
        Some(MergeRefusal::OtherPath)
    );
}

#[test]
fn refuses_merging_a_workspace_into_itself() {
    assert_eq!(
        merge_refusal(&side("a"), &side("a"), HOME),
        Some(MergeRefusal::SelfTarget)
    );
}

#[test]
fn never_merges_the_manager_workspace_either_way() {
    assert_eq!(
        merge_refusal(&of_kind("a", WorkspaceKind::Manager), &side("b"), HOME),
        Some(MergeRefusal::Manager)
    );
    assert_eq!(
        merge_refusal(&side("a"), &of_kind("b", WorkspaceKind::Manager), HOME),
        Some(MergeRefusal::Manager)
    );
}

#[test]
fn refuses_a_workspace_in_another_window() {
    assert_eq!(
        merge_refusal(&side("a"), &in_window("b", "win2"), HOME),
        Some(MergeRefusal::OtherWindow)
    );
}

#[test]
fn treats_a_workspace_without_a_window_as_a_different_window_from_one_with_a_window() {
    let loose = MergeSide {
        window_id: None,
        ..side("b")
    };
    assert_eq!(
        merge_refusal(&side("a"), &loose, HOME),
        Some(MergeRefusal::OtherWindow)
    );
    let other_loose = MergeSide {
        window_id: None,
        ..side("c")
    };
    assert_eq!(merge_refusal(&loose, &other_loose, HOME), None);
}

#[test]
fn refuses_a_sandboxed_and_a_plain_workspace() {
    assert_eq!(
        merge_refusal(&with_sandbox("a", sandbox()), &side("b"), HOME),
        Some(MergeRefusal::SandboxMixed)
    );
    assert_eq!(
        merge_refusal(&side("a"), &with_sandbox("b", sandbox()), HOME),
        Some(MergeRefusal::SandboxMixed)
    );
}

#[test]
fn merges_two_sandboxes_only_when_their_settings_are_the_same() {
    let one = WorkspaceSandbox {
        domains: domains(&["a.dev", "b.dev"]),
        controls: browser_allowlist(),
        ..sandbox()
    };
    let same = WorkspaceSandbox {
        domains: domains(&["b.dev", "a.dev"]),
        controls: browser_allowlist(),
        ..sandbox()
    };
    let other = WorkspaceSandbox {
        domains: domains(&["a.dev"]),
        controls: browser_allowlist(),
        ..sandbox()
    };
    assert_eq!(
        merge_refusal(
            &with_sandbox("a", one.clone()),
            &with_sandbox("b", same),
            HOME
        ),
        None
    );
    assert_eq!(
        merge_refusal(&with_sandbox("a", one), &with_sandbox("b", other), HOME),
        Some(MergeRefusal::SandboxDiffers)
    );
}

#[test]
fn treats_a_disabled_sandbox_with_leftover_settings_like_no_sandbox() {
    let off = WorkspaceSandbox {
        domains: domains(&["a.dev"]),
        ..WorkspaceSandbox::empty()
    };
    assert_eq!(
        merge_refusal(&with_sandbox("a", off), &side("b"), HOME),
        None
    );
}

#[test]
fn checks_self_then_manager_then_folder_then_window_then_sandbox() {
    let manager = of_kind("a", WorkspaceKind::Manager);
    assert_eq!(
        merge_refusal(&manager, &manager, HOME),
        Some(MergeRefusal::SelfTarget)
    );
    let far_manager = MergeSide {
        work_dir: "/elsewhere".to_owned(),
        ..of_kind("b", WorkspaceKind::Manager)
    };
    assert_eq!(
        merge_refusal(&side("a"), &far_manager, HOME),
        Some(MergeRefusal::Manager)
    );
    let far_other_window = MergeSide {
        window_id: Some("win2".to_owned()),
        ..in_dir("b", "/elsewhere")
    };
    assert_eq!(
        merge_refusal(&side("a"), &far_other_window, HOME),
        Some(MergeRefusal::OtherPath)
    );
    let other_window_sandboxed = MergeSide {
        sandbox: Some(sandbox()),
        ..in_window("b", "win2")
    };
    assert_eq!(
        merge_refusal(&side("a"), &other_window_sandboxed, HOME),
        Some(MergeRefusal::OtherWindow)
    );
}

#[test]
fn lists_same_folder_workspaces_with_the_reason_a_refused_one_cannot_merge() {
    let source = side("a");
    let candidates = vec![
        source.clone(),
        side("b"),
        in_dir("c", "/home/u/elsewhere"),
        of_kind("d", WorkspaceKind::Manager),
        in_window("e", "win2"),
        MergeSide {
            window_id: Some("win2".to_owned()),
            ..in_dir("g", "/home/u/elsewhere")
        },
        with_sandbox("f", sandbox()),
    ];
    assert_eq!(
        merge_options(&source, &candidates, HOME),
        vec![
            MergeOption {
                target_id: "b".to_owned(),
                refusal: None
            },
            MergeOption {
                target_id: "e".to_owned(),
                refusal: Some(MergeOptionRefusal::OtherWindow)
            },
            MergeOption {
                target_id: "f".to_owned(),
                refusal: Some(MergeOptionRefusal::SandboxMixed)
            },
        ]
    );
}

#[test]
fn lists_a_sandbox_that_differs_with_its_reason() {
    let source = with_sandbox("a", sandbox());
    let other = WorkspaceSandbox {
        domains: domains(&["x.dev"]),
        ..sandbox()
    };
    assert_eq!(
        merge_options(&source, &[with_sandbox("b", other)], HOME),
        vec![MergeOption {
            target_id: "b".to_owned(),
            refusal: Some(MergeOptionRefusal::SandboxDiffers)
        }]
    );
}
