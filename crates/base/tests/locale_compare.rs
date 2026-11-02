#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cmp::Ordering;
use std::path::PathBuf;

use ostia_base::js::locale_compare;
use serde_json::Value;

fn sign(order: Ordering) -> i64 {
    order as i64
}

#[test]
fn matches_every_pair_that_node_ordered() {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust/locale-compare.json");
    let table: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let rows = table.as_array().unwrap();
    assert!(rows.len() > 700);
    for row in rows {
        let (a, b) = (row["a"].as_str().unwrap(), row["b"].as_str().unwrap());
        let expected = row["order"].as_i64().unwrap();
        assert_eq!(sign(locale_compare(a, b)), expected, "{a:?} against {b:?}");
    }
}

#[test]
fn sorts_like_node_for_the_known_cases() {
    let mut words = ["Zeta", "alpha"];
    words.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(words, ["alpha", "Zeta"]);
    let mut marks = ["ab", "a/b", "a-b", "a_b"];
    marks.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(marks, ["a_b", "a-b", "a/b", "ab"]);
}
