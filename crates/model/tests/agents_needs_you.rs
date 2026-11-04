#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_approvals::approval_answers::ApprovalKind;
use ostia_approvals::asks::{ApprovalRequest, QuestionRequest};
use ostia_contract::capabilities::Capability;
use ostia_model::agents::needs_you::{
    CONTEXT_FOLD_CHARS, NeedsYouItem, PaneWhere, WHERE_PATH_CHARS, WhereWorkspace, is_long_context,
    needs_you_items, pane_where, source_where,
};
use ostia_model::ids::IdMint;
use ostia_model::layout::tree::create_pane;
use ostia_model::layout::types::{LayoutNode, SurfaceKind};

fn question(id: &str, at: i64) -> QuestionRequest {
    QuestionRequest {
        id: id.to_owned(),
        pane_id: "p1".to_owned(),
        question: id.to_owned(),
        context: String::new(),
        choices: Vec::new(),
        at,
        permission: None,
        source_workspace: None,
    }
}

fn approval(id: &str, at: i64) -> ApprovalRequest {
    ApprovalRequest {
        id: id.to_owned(),
        kind: Some(ApprovalKind::Capability),
        pane_id: "p1".to_owned(),
        caps: vec![Capability::Shell],
        action: "a".to_owned(),
        detail: String::new(),
        at,
    }
}

fn ids_of(items: &[NeedsYouItem]) -> Vec<&str> {
    items.iter().map(NeedsYouItem::id).collect()
}

fn workspace(id: &str, name: &str, work_dir: &str) -> WhereWorkspace {
    WhereWorkspace {
        id: id.to_owned(),
        name: name.to_owned(),
        custom_name: None,
        work_dir: work_dir.to_owned(),
        project_dir: None,
    }
}

const LONG_DIR: &str = "/home/u/a/very/long/path/to/some/deeply/nested/project/web";

fn workspaces() -> Vec<WhereWorkspace> {
    vec![
        workspace("w1", "api", "~/work/api"),
        WhereWorkspace {
            custom_name: Some("Storefront".to_owned()),
            project_dir: Some(LONG_DIR.to_owned()),
            ..workspace("w2", "web", LONG_DIR)
        },
    ]
}

fn claude_pane() -> (String, LayoutNode) {
    let mut ids = IdMint::default();
    let mut pane = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    pane.title = "claude".to_owned();
    (pane.id.clone(), pane.into())
}

#[test]
fn lists_questions_and_approvals_together_oldest_first() {
    let items = needs_you_items(
        &[question("q-new", 30), question("q-old", 10)],
        &[],
        &[approval("a-mid", 20)],
    );
    assert_eq!(ids_of(&items), ["q-old", "a-mid", "q-new"]);
}

#[test]
fn keeps_an_answered_question_in_place_as_sent_until_it_is_dropped() {
    let items = needs_you_items(&[question("q2", 20)], &[question("q1", 10)], &[]);
    let seen: Vec<(&str, bool)> = items
        .iter()
        .map(|item| {
            (
                item.id(),
                matches!(item, NeedsYouItem::Question { sent: true, .. }),
            )
        })
        .collect();
    assert_eq!(seen, [("q1", true), ("q2", false)]);
}

#[test]
fn shows_a_question_once_when_it_is_both_open_and_marked_sent() {
    let q = question("q1", 10);
    let items = needs_you_items(std::slice::from_ref(&q), std::slice::from_ref(&q), &[]);
    assert_eq!(items.len(), 1);
    assert!(matches!(
        items[0],
        NeedsYouItem::Question { sent: false, .. }
    ));
}

#[test]
fn keeps_the_order_of_questions_sent_then_approvals_when_times_are_equal() {
    let items = needs_you_items(
        &[question("open", 5)],
        &[question("sent", 5)],
        &[approval("ask", 5)],
    );
    assert_eq!(ids_of(&items), ["open", "sent", "ask"]);
}

#[test]
fn returns_the_time_of_each_item() {
    let items = needs_you_items(&[question("q", 7)], &[], &[approval("a", 9)]);
    let times: Vec<i64> = items.iter().map(NeedsYouItem::at).collect();
    assert_eq!(times, [7, 9]);
}

#[test]
fn returns_nothing_when_nothing_waits() {
    assert!(needs_you_items(&[], &[], &[]).is_empty());
}

#[test]
fn folds_a_context_with_many_lines_or_many_characters() {
    assert!(!is_long_context("short"));
    assert!(!is_long_context("a\nb\nc\nd"));
    assert!(is_long_context("a\nb\nc\nd\ne"));
    assert!(is_long_context(&"x".repeat(CONTEXT_FOLD_CHARS + 1)));
}

#[test]
fn does_not_fold_a_context_of_exactly_the_character_limit() {
    assert!(!is_long_context(&"x".repeat(CONTEXT_FOLD_CHARS)));
}

#[test]
fn counts_the_length_of_a_context_in_utf16_units() {
    let wide = "😀".repeat(CONTEXT_FOLD_CHARS / 2 + 1);
    assert!(wide.chars().count() <= CONTEXT_FOLD_CHARS);
    assert!(is_long_context(&wide));
}

#[test]
fn names_the_workspace_its_folder_and_the_pane_that_holds_the_pane_id() {
    let (pane_id, root) = claude_pane();
    let layouts = HashMap::from([("w1".to_owned(), root)]);
    assert_eq!(
        pane_where(&pane_id, &workspaces(), &layouts),
        Some(PaneWhere {
            workspace_id: "w1".to_owned(),
            workspace: "api".to_owned(),
            path: "~/work/api".to_owned(),
            short_path: "~/work/api".to_owned(),
            pane: "claude".to_owned(),
        })
    );
}

#[test]
fn prefers_the_custom_name_and_shortens_a_long_folder_from_the_middle() {
    let (pane_id, root) = claude_pane();
    let layouts = HashMap::from([("w2".to_owned(), root)]);
    let place = pane_where(&pane_id, &workspaces(), &layouts).unwrap();
    assert_eq!(place.workspace, "Storefront");
    assert_eq!(place.path, LONG_DIR);
    assert_eq!(
        place.short_path,
        "/…/path/to/some/deeply/nested/project/web"
    );
}

#[test]
fn answers_null_for_a_pane_no_workspace_holds() {
    let (_, root) = claude_pane();
    let layouts = HashMap::from([("w1".to_owned(), root)]);
    assert_eq!(pane_where("gone", &workspaces(), &layouts), None);
}

#[test]
fn skips_a_workspace_that_has_no_layout() {
    let (pane_id, root) = claude_pane();
    let layouts = HashMap::from([("w2".to_owned(), root)]);
    let place = pane_where(&pane_id, &workspaces(), &layouts).unwrap();
    assert_eq!(place.workspace_id, "w2");
}

#[test]
fn answers_with_the_first_workspace_that_holds_the_pane() {
    let (pane_id, root) = claude_pane();
    let layouts = HashMap::from([("w1".to_owned(), root.clone()), ("w2".to_owned(), root)]);
    let place = pane_where(&pane_id, &workspaces(), &layouts).unwrap();
    assert_eq!(place.workspace_id, "w1");
}

#[test]
fn prefers_the_project_folder_over_the_work_folder() {
    let (pane_id, root) = claude_pane();
    let layouts = HashMap::from([("w1".to_owned(), root)]);
    let mut list = workspaces();
    list[0].project_dir = Some("~/work/mono".to_owned());
    let place = pane_where(&pane_id, &list, &layouts).unwrap();
    assert_eq!(place.path, "~/work/mono");
}

#[test]
fn shortens_the_folder_to_the_where_path_limit() {
    assert_eq!(WHERE_PATH_CHARS, 44);
}

#[test]
fn names_the_workspace_and_the_extension_for_a_source() {
    let source = ("ext-notes", "w2");
    let place = source_where(source.0, source.1, &workspaces()).unwrap();
    assert_eq!(
        place,
        PaneWhere {
            workspace_id: "w2".to_owned(),
            workspace: "Storefront".to_owned(),
            path: LONG_DIR.to_owned(),
            short_path: "/…/path/to/some/deeply/nested/project/web".to_owned(),
            pane: "ext-notes".to_owned(),
        }
    );
}

#[test]
fn answers_null_for_a_source_in_no_workspace() {
    assert_eq!(source_where("ext-notes", "gone", &workspaces()), None);
}

#[test]
fn uses_the_work_folder_for_a_source_without_a_project_folder() {
    let place = source_where("ext-notes", "w1", &workspaces()).unwrap();
    assert_eq!(place.path, "~/work/api");
    assert_eq!(place.workspace, "api");
}
