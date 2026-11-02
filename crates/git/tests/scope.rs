#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_git::git::{BranchRef, GraphScope, ScopePlan};
use ostia_git::history::FIELD_SEP;
use ostia_git::scope::{BRANCH_REF_FORMAT, parse_branch_refs, parse_scope, plan_scope};
use serde_json::{Value, json};

fn line(fields: &[&str]) -> String {
    fields.join(FIELD_SEP)
}

fn branches() -> Vec<BranchRef> {
    let output = [
        line(&["refs/heads/feature", &"f".repeat(40), "300", ""]),
        line(&["refs/remotes/origin/main", &"b".repeat(40), "400", ""]),
        line(&[
            "refs/remotes/origin/HEAD",
            &"b".repeat(40),
            "400",
            "refs/remotes/origin/main",
        ]),
        line(&["refs/heads/main", &"a".repeat(40), "100", ""]),
        line(&["refs/heads/old", &"c".repeat(40), "50", ""]),
    ]
    .join("\n");
    parse_branch_refs(&output, Some("main"))
}

fn chosen(refs: &[&str]) -> GraphScope {
    GraphScope::Chosen {
        refs: refs.iter().map(|r| (*r).to_owned()).collect(),
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn names(refs: &[BranchRef]) -> Vec<&str> {
    refs.iter().map(|b| b.name.as_str()).collect()
}

fn scope_of(raw: Value) -> Option<GraphScope> {
    parse_scope(&raw)
}

#[test]
fn lists_the_current_branch_first_then_local_and_remote_branches_by_recency() {
    let branches = branches();
    assert_eq!(names(&branches), ["main", "feature", "old", "origin/main"]);
    assert_eq!(branches[0].r#ref, "refs/heads/main");
    assert!(branches[0].current);
    assert!(!branches[0].remote);
    assert!(branches[3].remote);
    assert!(!branches[3].current);
}

#[test]
fn drops_symbolic_refs_such_as_origin_head() {
    assert!(
        !branches()
            .iter()
            .any(|b| b.r#ref == "refs/remotes/origin/HEAD")
    );
}

#[test]
fn accepts_the_three_scope_kinds() {
    assert_eq!(
        scope_of(json!({"kind": "current"})),
        Some(GraphScope::Current)
    );
    assert_eq!(
        scope_of(json!({"kind": "all", "refs": ["x"]})),
        Some(GraphScope::All)
    );
    assert_eq!(
        scope_of(json!({"kind": "chosen", "refs": ["refs/heads/a", "refs/heads/a"]})),
        Some(chosen(&["refs/heads/a"]))
    );
}

#[test]
fn refuses_anything_that_is_not_a_branch_ref_so_no_option_reaches_git() {
    assert_eq!(
        scope_of(json!({"kind": "chosen", "refs": ["--all", "HEAD", "refs/tags/v1", 7]})),
        None
    );
    assert_eq!(
        scope_of(json!({"kind": "chosen", "refs": ["refs/heads/a", "--output=x"]})),
        Some(chosen(&["refs/heads/a"]))
    );
    assert_eq!(scope_of(json!({"kind": "everything"})), None);
    assert_eq!(scope_of(json!("all")), None);
}

#[test]
fn shows_only_the_current_branch_by_default() {
    assert_eq!(
        plan_scope(&GraphScope::Current, &branches()),
        ScopePlan {
            scope: GraphScope::Current,
            revisions: strings(&["HEAD"]),
            includes_head: true,
        }
    );
}

#[test]
fn shows_local_and_remote_branches_plus_a_detached_head_for_all() {
    assert_eq!(
        plan_scope(&GraphScope::All, &branches()).revisions,
        strings(&["--branches", "--remotes", "HEAD"])
    );
}

#[test]
fn keeps_only_chosen_branches_that_still_exist_after_end_of_options() {
    let branches = branches();
    let plan = plan_scope(
        &chosen(&[
            "refs/heads/feature",
            "refs/heads/gone",
            "refs/remotes/origin/main",
        ]),
        &branches,
    );
    assert_eq!(
        plan.scope,
        chosen(&["refs/heads/feature", "refs/remotes/origin/main"])
    );
    assert_eq!(
        plan.revisions,
        strings(&[
            "--end-of-options",
            "refs/heads/feature",
            "refs/remotes/origin/main",
        ])
    );
    assert!(!plan.includes_head);
    assert!(plan_scope(&chosen(&["refs/heads/main"]), &branches).includes_head);
}

#[test]
fn falls_back_to_the_current_branch_when_none_of_the_chosen_branches_exist() {
    assert_eq!(
        plan_scope(&chosen(&["refs/heads/gone"]), &branches()).scope,
        GraphScope::Current
    );
}

#[test]
fn falls_back_to_head_with_the_current_scope_for_a_chosen_scope_with_no_refs() {
    assert_eq!(
        plan_scope(&chosen(&[]), &branches()),
        ScopePlan {
            scope: GraphScope::Current,
            revisions: strings(&["HEAD"]),
            includes_head: true,
        }
    );
}

#[test]
fn plans_all_with_the_all_scope_and_includes_head_even_with_no_branches() {
    assert_eq!(
        plan_scope(&GraphScope::All, &[]),
        ScopePlan {
            scope: GraphScope::All,
            revisions: strings(&["--branches", "--remotes", "HEAD"]),
            includes_head: true,
        }
    );
}

#[test]
fn keeps_the_order_of_the_chosen_refs_and_not_the_order_of_the_branches() {
    let plan = plan_scope(
        &chosen(&["refs/remotes/origin/main", "refs/heads/feature"]),
        &branches(),
    );
    assert_eq!(
        plan.revisions,
        strings(&[
            "--end-of-options",
            "refs/remotes/origin/main",
            "refs/heads/feature",
        ])
    );
}

#[test]
fn does_not_count_a_remote_branch_with_the_head_name_as_head() {
    let branches = parse_branch_refs(
        &[
            line(&["refs/heads/main", &"a".repeat(40), "100", ""]),
            line(&["refs/remotes/main", &"b".repeat(40), "200", ""]),
        ]
        .join("\n"),
        Some("main"),
    );
    let plan = plan_scope(&chosen(&["refs/remotes/main"]), &branches);
    assert!(!plan.includes_head);
}

#[test]
fn reads_the_branch_ref_format_with_the_four_fields_in_order() {
    assert_eq!(
        BRANCH_REF_FORMAT,
        line(&[
            "%(refname)",
            "%(objectname)",
            "%(committerdate:unix)",
            "%(symref)",
        ])
    );
}

#[test]
fn keeps_all_fields_of_a_parsed_branch_ref() {
    let branches = parse_branch_refs(
        &line(&["refs/remotes/origin/dev", &"d".repeat(40), "77", ""]),
        None,
    );
    assert_eq!(
        branches,
        vec![BranchRef {
            r#ref: "refs/remotes/origin/dev".to_owned(),
            name: "origin/dev".to_owned(),
            remote: true,
            current: false,
            sha: "d".repeat(40),
            time: 77,
        }]
    );
}

#[test]
fn marks_no_branch_current_when_head_is_detached() {
    let output = line(&["refs/heads/main", &"a".repeat(40), "100", ""]);
    let branches = parse_branch_refs(&output, None);
    assert!(!branches[0].current);
}

#[test]
fn skips_empty_lines_and_lines_with_a_missing_ref_or_sha() {
    let output = [
        String::new(),
        line(&["", &"a".repeat(40), "1", ""]),
        line(&["refs/heads/nosha", "", "1", ""]),
        line(&["refs/heads/ok", &"a".repeat(40), "1", ""]),
        String::new(),
    ]
    .join("\n");
    assert_eq!(names(&parse_branch_refs(&output, None)), ["ok"]);
}

#[test]
fn skips_refs_that_are_not_branches_or_that_hold_whitespace_or_are_too_long() {
    let long_ok = format!("refs/heads/{}", "x".repeat(256 - "refs/heads/".len()));
    let long_bad = format!("{long_ok}x");
    let output = [
        line(&["refs/tags/v1", &"a".repeat(40), "1", ""]),
        line(&["refs/heads/has space", &"a".repeat(40), "1", ""]),
        line(&["refs/heads/has\ttab", &"a".repeat(40), "1", ""]),
        line(&[&long_bad, &"a".repeat(40), "1", ""]),
        line(&[&long_ok, &"a".repeat(40), "1", ""]),
    ]
    .join("\n");
    let branches = parse_branch_refs(&output, None);
    assert_eq!(branches.len(), 1);
    assert_eq!(branches[0].r#ref, long_ok);
}

#[test]
fn reads_a_time_that_is_not_a_number_as_zero() {
    let output = [
        line(&["refs/heads/a", &"a".repeat(40), "", ""]),
        line(&["refs/heads/b", &"a".repeat(40), "soon", ""]),
        line(&["refs/heads/c", &"a".repeat(40), "5", ""]),
    ]
    .join("\n");
    let times: Vec<i64> = parse_branch_refs(&output, None)
        .iter()
        .map(|b| b.time)
        .collect();
    assert_eq!(times, [5, 0, 0]);
}

#[test]
fn sorts_local_before_remote_then_by_newest_time_then_by_name() {
    let output = [
        line(&["refs/remotes/origin/new", &"a".repeat(40), "900", ""]),
        line(&["refs/heads/b", &"a".repeat(40), "10", ""]),
        line(&["refs/heads/a", &"a".repeat(40), "10", ""]),
        line(&["refs/heads/newer", &"a".repeat(40), "20", ""]),
    ]
    .join("\n");
    assert_eq!(
        names(&parse_branch_refs(&output, None)),
        ["newer", "a", "b", "origin/new"]
    );
}

#[test]
fn keeps_at_most_64_chosen_refs_after_removing_duplicates() {
    let refs: Vec<String> = (0..70)
        .flat_map(|i| [format!("refs/heads/b{i}"), format!("refs/heads/b{i}")])
        .collect();
    let Some(GraphScope::Chosen { refs: kept }) = scope_of(json!({"kind": "chosen", "refs": refs}))
    else {
        panic!("expected a chosen scope");
    };
    assert_eq!(kept.len(), 64);
    assert_eq!(kept[0], "refs/heads/b0");
    assert_eq!(kept[63], "refs/heads/b63");
}

#[test]
fn refuses_refs_with_whitespace_a_nul_or_more_than_256_characters() {
    for (case, raw) in [
        ("space", "refs/heads/a b".to_owned()),
        ("newline", "refs/heads/a\nb".to_owned()),
        ("nul", "refs/heads/a\0b".to_owned()),
        ("too long", format!("refs/heads/{}", "x".repeat(250))),
        ("no prefix", "heads/a".to_owned()),
    ] {
        assert_eq!(
            scope_of(json!({"kind": "chosen", "refs": [raw]})),
            None,
            "{case}"
        );
    }
    let exact = format!("refs/heads/{}", "x".repeat(256 - "refs/heads/".len()));
    assert_eq!(
        scope_of(json!({"kind": "chosen", "refs": [exact.clone()]})),
        Some(GraphScope::Chosen { refs: vec![exact] })
    );
}

#[test]
fn accepts_remote_refs_in_a_chosen_scope() {
    assert_eq!(
        scope_of(json!({"kind": "chosen", "refs": ["refs/remotes/origin/main"]})),
        Some(chosen(&["refs/remotes/origin/main"]))
    );
}

#[test]
fn refuses_a_scope_that_is_not_an_object_or_has_a_bad_kind_or_refs() {
    for (case, raw) in [
        ("null", Value::Null),
        ("array", json!([])),
        ("number", json!(3)),
        ("no kind", json!({})),
        ("kind is a number", json!({"kind": 1})),
        ("chosen without refs", json!({"kind": "chosen"})),
        (
            "chosen with a string",
            json!({"kind": "chosen", "refs": "refs/heads/a"}),
        ),
        (
            "chosen with an object",
            json!({"kind": "chosen", "refs": {"0": "refs/heads/a"}}),
        ),
        ("chosen with no refs", json!({"kind": "chosen", "refs": []})),
    ] {
        assert_eq!(scope_of(raw), None, "{case}");
    }
}

#[test]
fn breaks_a_time_tie_by_locale_order_not_by_bytes() {
    let output = [
        line(&["refs/heads/Zeta", &"a".repeat(40), "10", ""]),
        line(&["refs/heads/alpha", &"b".repeat(40), "10", ""]),
        line(&["refs/heads/a_b", &"c".repeat(40), "10", ""]),
        line(&["refs/heads/a-b", &"d".repeat(40), "10", ""]),
        line(&["refs/heads/ab", &"e".repeat(40), "10", ""]),
    ]
    .join("\n");
    let branches = parse_branch_refs(&output, None);
    assert_eq!(names(&branches), ["a_b", "a-b", "ab", "alpha", "Zeta"]);
}
