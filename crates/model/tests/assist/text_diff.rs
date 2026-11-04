use std::path::PathBuf;

use ostia_model::assist::text_diff::{Change, diff_lines, diff_words_with_space};
use serde_json::Value;

fn changes_of(rows: &[Value]) -> Vec<Change> {
    rows.iter()
        .map(|row| Change {
            added: row["added"].as_bool().unwrap(),
            removed: row["removed"].as_bool().unwrap(),
            value: row["value"].as_str().unwrap().to_owned(),
        })
        .collect()
}

#[test]
fn matches_every_diff_that_jsdiff_gave() {
    let file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/rust/text-diff.json");
    let table: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let rows = table.as_array().unwrap();
    assert!(rows.len() > 30);
    for row in rows {
        let before = row["before"].as_str().unwrap();
        let after = row["after"].as_str().unwrap();
        let max_edits = row["maxEdits"].as_u64().map(|edits| edits as usize);
        let expected = row["changes"].as_array().map(|list| changes_of(list));
        let actual = match row["mode"].as_str().unwrap() {
            "lines" => Some(diff_lines(before, after)),
            "words" => diff_words_with_space(before, after, max_edits),
            other => panic!("unknown mode {other}"),
        };
        assert_eq!(actual, expected, "{row}");
    }
}
