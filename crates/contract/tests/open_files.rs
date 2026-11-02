#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use ostia_contract::open_files::{
    FileTarget, OPEN_FILES_MAX, OpenTargetKind, open_target_kind, opened_pane_ids,
    parse_file_targets,
};
use serde_json::{Value, json};

fn target(path: &str, line: Option<u64>, column: Option<u64>) -> FileTarget {
    FileTarget {
        path: PathBuf::from(path),
        line,
        column,
    }
}

#[test]
fn keeps_a_path_with_a_positive_line_and_column() {
    assert_eq!(
        parse_file_targets(&json!([{"path": "/a.ts", "line": 3, "column": 2}, {"path": "/b.png"}])),
        Some(vec![
            target("/a.ts", Some(3), Some(2)),
            target("/b.png", None, None)
        ])
    );
}

#[test]
fn drops_a_position_that_is_not_a_positive_whole_number_and_a_column_without_a_line() {
    assert_eq!(
        parse_file_targets(&json!([{"path": "/a.ts", "line": 0, "column": 4}])),
        Some(vec![target("/a.ts", None, None)])
    );
    assert_eq!(
        parse_file_targets(&json!([{"path": "/a.ts", "line": "3"}])),
        Some(vec![target("/a.ts", None, None)])
    );
    assert_eq!(
        parse_file_targets(&json!([{"path": "/a.ts", "line": 2, "column": 1.5}])),
        Some(vec![target("/a.ts", Some(2), None)])
    );
}

#[test]
fn refuses_anything_but_a_short_list_of_paths() {
    assert_eq!(parse_file_targets(&Value::Null), None);
    assert_eq!(parse_file_targets(&json!([])), None);
    assert_eq!(parse_file_targets(&json!(["/a.ts"])), None);
    assert_eq!(parse_file_targets(&json!([{"path": ""}])), None);
    assert_eq!(parse_file_targets(&json!([{"path": 7}])), None);
    let many: Vec<Value> = (0..=OPEN_FILES_MAX)
        .map(|index| json!({"path": format!("/f{index}")}))
        .collect();
    assert_eq!(parse_file_targets(&Value::Array(many)), None);
}

#[test]
fn takes_a_word_for_a_url_only_when_it_starts_with_http_or_https() {
    assert_eq!(
        open_target_kind("https://example.com/a"),
        OpenTargetKind::Url
    );
    assert_eq!(
        open_target_kind("HTTP://127.0.0.1:3000"),
        OpenTargetKind::Url
    );
    for word in [
        "example.com",
        "localhost:3000",
        "www.example.com/a",
        "ftp://x/",
        "http:",
    ] {
        assert_eq!(open_target_kind(word), OpenTargetKind::Path, "{word}");
    }
}

#[test]
fn reads_a_lone_dash_as_stdin_and_nothing_else() {
    assert_eq!(open_target_kind("-"), OpenTargetKind::Stdin);
    assert_eq!(open_target_kind("--"), OpenTargetKind::Path);
    assert_eq!(open_target_kind("-x"), OpenTargetKind::Path);
}

#[test]
fn accepts_exactly_the_maximum_number_of_targets() {
    let at_limit: Vec<Value> = (0..OPEN_FILES_MAX)
        .map(|index| json!({"path": format!("/f{index}")}))
        .collect();
    assert_eq!(
        parse_file_targets(&Value::Array(at_limit)).map(|targets| targets.len()),
        Some(OPEN_FILES_MAX)
    );
}

#[test]
fn refuses_the_whole_list_when_one_entry_has_no_path() {
    assert_eq!(
        parse_file_targets(&json!([{"path": "/a.ts"}, {"line": 3}])),
        None
    );
    assert_eq!(parse_file_targets(&json!([{"path": "/a.ts"}, null])), None);
}

#[test]
fn keeps_a_whole_number_written_with_a_fraction_part() {
    assert_eq!(
        parse_file_targets(&json!([{"path": "/a.ts", "line": 4.0, "column": 2.0}])),
        Some(vec![target("/a.ts", Some(4), Some(2))])
    );
}

#[test]
fn collects_the_pane_ids_of_opened_entries_and_skips_the_others() {
    assert_eq!(
        opened_pane_ids(&json!({"opened": [
            {"path": "/a", "paneId": "p1"},
            {"path": "/b"},
            {"path": "/c", "paneId": 7},
            null,
            {"path": "/d", "paneId": "p2"}
        ]})),
        ["p1", "p2"]
    );
}

#[test]
fn gives_no_pane_ids_when_the_result_has_no_opened_list() {
    for result in [
        Value::Null,
        json!({}),
        json!({"opened": "p1"}),
        json!({"opened": {"paneId": "p1"}}),
        json!("x"),
    ] {
        assert!(opened_pane_ids(&result).is_empty(), "{result}");
    }
}
