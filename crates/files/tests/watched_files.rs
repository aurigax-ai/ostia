#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

use ostia_files::file_watch::{TreeChange, TreeChangeKind};
use ostia_files::watched_files::{parse_file_watchers, watched_file_events};
use serde_json::{Value, json};

const ROOT: &str = "/home/u/work";

fn change(path: &str, kind: TreeChangeKind) -> TreeChange {
    TreeChange {
        path: PathBuf::from(path),
        kind,
    }
}

fn events(register_options: &Value, changes: &[TreeChange]) -> Vec<Value> {
    let watchers = parse_file_watchers(register_options, Path::new(ROOT));
    watched_file_events(&watchers, changes, Path::new(ROOT))
        .iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect()
}

#[test]
fn matches_a_relative_glob_against_the_path_under_the_session_root() {
    let got = events(
        &json!({"watchers": [{"globPattern": "**/*.{toml,cfg}"}]}),
        &[
            change("/home/u/work/pkg/a.toml", TreeChangeKind::Created),
            change("/home/u/work/.hidden/b.cfg", TreeChangeKind::Changed),
            change("/home/u/work/pkg/c.txt", TreeChangeKind::Changed),
            change("/home/u/work/d.toml", TreeChangeKind::Deleted),
        ],
    );
    assert_eq!(
        got,
        vec![
            json!({"uri": "file:///home/u/work/pkg/a.toml", "type": 1}),
            json!({"uri": "file:///home/u/work/.hidden/b.cfg", "type": 2}),
            json!({"uri": "file:///home/u/work/d.toml", "type": 3}),
        ]
    );
}

#[test]
fn reports_only_the_kinds_a_watcher_asked_for() {
    let got = events(
        &json!({"watchers": [{"globPattern": "**/*.txt", "kind": 4}]}),
        &[
            change("/home/u/work/a.txt", TreeChangeKind::Created),
            change("/home/u/work/a.txt", TreeChangeKind::Deleted),
        ],
    );
    assert_eq!(
        got,
        vec![json!({"uri": "file:///home/u/work/a.txt", "type": 3})]
    );
}

#[test]
fn matches_a_relative_pattern_under_its_base_folder_given_as_a_uri_or_a_workspace_folder() {
    let changes = [
        change("/home/u/work/pkg/src/a.py", TreeChangeKind::Changed),
        change("/home/u/work/other/a.py", TreeChangeKind::Changed),
    ];
    let bases = [
        json!("file:///home/u/work/pkg"),
        json!({"uri": "file:///home/u/work/pkg", "name": "p"}),
    ];
    for base in bases {
        let got = events(
            &json!({"watchers": [{"globPattern": {"baseUri": base, "pattern": "**/*.py"}}]}),
            &changes,
        );
        assert_eq!(
            got,
            vec![json!({"uri": "file:///home/u/work/pkg/src/a.py", "type": 2})],
            "base {base}"
        );
    }
}

#[test]
fn drops_a_watcher_based_outside_the_session_root_and_never_reports_a_path_outside_it() {
    let dropped = parse_file_watchers(
        &json!({"watchers": [
            {"globPattern": {"baseUri": "file:///home/u", "pattern": "**"}},
            {"globPattern": {"baseUri": "file:///home/u/workshop", "pattern": "**"}},
            {"globPattern": {"baseUri": "https://example.com/x", "pattern": "**"}},
            {"globPattern": 7},
            "junk",
        ]}),
        Path::new(ROOT),
    );
    assert!(dropped.is_empty());
    let got = events(
        &json!({"watchers": [{"globPattern": "/home/u/**/*.txt"}]}),
        &[
            change("/home/u/secret.txt", TreeChangeKind::Changed),
            change("/home/u/work/ok.txt", TreeChangeKind::Changed),
        ],
    );
    assert_eq!(
        got,
        vec![json!({"uri": "file:///home/u/work/ok.txt", "type": 2})]
    );
}

#[test]
fn parses_no_watchers_when_the_register_options_have_no_watcher_list() {
    for options in [
        json!(null),
        json!("x"),
        json!([]),
        json!({}),
        json!({"watchers": "x"}),
        json!({"watchers": {"globPattern": "**"}}),
    ] {
        let watchers = parse_file_watchers(&options, Path::new(ROOT));
        assert!(watchers.is_empty(), "options {options}");
    }
}

#[test]
fn drops_a_watcher_with_an_empty_non_string_or_over_long_pattern() {
    let long = "a".repeat(1001);
    let limit = "a".repeat(1000);
    let watchers = parse_file_watchers(
        &json!({"watchers": [
            {"globPattern": ""},
            {"globPattern": long},
            {"globPattern": {"baseUri": "file:///home/u/work", "pattern": ""}},
            {"globPattern": {"baseUri": "file:///home/u/work", "pattern": 3}},
            {"globPattern": limit},
        ]}),
        Path::new(ROOT),
    );
    assert_eq!(watchers.len(), 1);
}

#[test]
fn keeps_the_first_200_watchers_only() {
    let list: Vec<Value> = (0..250)
        .map(|index| json!({"globPattern": format!("**/{index}.txt")}))
        .collect();
    let watchers = parse_file_watchers(&json!({"watchers": list.clone()}), Path::new(ROOT));
    assert_eq!(watchers.len(), 200);
    let got = events(
        &json!({"watchers": list}),
        &[
            change("/home/u/work/199.txt", TreeChangeKind::Changed),
            change("/home/u/work/200.txt", TreeChangeKind::Changed),
        ],
    );
    assert_eq!(
        got,
        vec![json!({"uri": "file:///home/u/work/199.txt", "type": 2})]
    );
}

#[test]
fn watches_every_kind_when_the_kind_is_missing_and_no_kind_when_it_masks_to_zero() {
    let changes = [
        change("/home/u/work/a.txt", TreeChangeKind::Created),
        change("/home/u/work/a.txt", TreeChangeKind::Changed),
        change("/home/u/work/a.txt", TreeChangeKind::Deleted),
    ];
    let table = [
        (json!({"globPattern": "*.txt"}), 3),
        (json!({"globPattern": "*.txt", "kind": "x"}), 3),
        (json!({"globPattern": "*.txt", "kind": 7}), 3),
        (json!({"globPattern": "*.txt", "kind": 15}), 3),
        (json!({"globPattern": "*.txt", "kind": 0}), 0),
        (json!({"globPattern": "*.txt", "kind": 8}), 0),
        (json!({"globPattern": "*.txt", "kind": 3}), 2),
        (json!({"globPattern": "*.txt", "kind": 5}), 2),
    ];
    for (watcher, expected) in table {
        let got = events(&json!({"watchers": [watcher]}), &changes);
        assert_eq!(got.len(), expected, "watcher {watcher}");
    }
}

#[test]
fn matches_a_base_relative_pattern_below_the_base_and_never_the_base_itself() {
    let got = events(
        &json!({"watchers": [{"globPattern": {"baseUri": "file:///home/u/work/pkg", "pattern": "**"}}]}),
        &[
            change("/home/u/work/pkg", TreeChangeKind::Changed),
            change("/home/u/work/pkg/a", TreeChangeKind::Changed),
            change("/home/u/work/pkg2/a", TreeChangeKind::Changed),
        ],
    );
    assert_eq!(
        got,
        vec![json!({"uri": "file:///home/u/work/pkg/a", "type": 2})]
    );
}

#[test]
fn matches_dot_files_and_a_plain_relative_glob_at_the_root() {
    let got = events(
        &json!({"watchers": [{"globPattern": "*.env"}]}),
        &[
            change("/home/u/work/.env", TreeChangeKind::Created),
            change("/home/u/work/a/.env", TreeChangeKind::Created),
        ],
    );
    assert_eq!(
        got,
        vec![json!({"uri": "file:///home/u/work/.env", "type": 1})]
    );
}

#[test]
fn reports_one_event_for_each_change_even_when_two_watchers_match() {
    let got = events(
        &json!({"watchers": [{"globPattern": "**/*.txt"}, {"globPattern": "**/a.*"}]}),
        &[change("/home/u/work/a.txt", TreeChangeKind::Changed)],
    );
    assert_eq!(got.len(), 1);
}

#[test]
fn stops_at_500_events() {
    let changes: Vec<TreeChange> = (0..600)
        .map(|index| {
            change(
                &format!("/home/u/work/f{index}.txt"),
                TreeChangeKind::Changed,
            )
        })
        .collect();
    let got = events(&json!({"watchers": [{"globPattern": "**"}]}), &changes);
    assert_eq!(got.len(), 500);
    assert_eq!(
        got[499],
        json!({"uri": "file:///home/u/work/f499.txt", "type": 2})
    );
}

#[test]
fn builds_a_percent_encoded_file_uri_from_the_changed_path() {
    let got = events(
        &json!({"watchers": [{"globPattern": "**"}]}),
        &[change("/home/u/work/a b#c.txt", TreeChangeKind::Created)],
    );
    assert_eq!(
        got,
        vec![json!({"uri": "file:///home/u/work/a%20b%23c.txt", "type": 1})]
    );
}

#[test]
fn reports_nothing_when_there_is_no_watcher() {
    let got = events(
        &json!({"watchers": []}),
        &[change("/home/u/work/a.txt", TreeChangeKind::Created)],
    );
    assert!(got.is_empty());
}
