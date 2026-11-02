#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_files::fuzzy_paths::fuzzy_match;

fn score(query: &str, path: &str) -> f64 {
    fuzzy_match(query, path).map_or(0.0, |hit| hit.score)
}

#[test]
fn matches_the_query_letters_in_order_ignoring_case_and_spaces() {
    let path = "src/renderer/components/Editor.tsx";
    let hit = fuzzy_match("Ed tsx", path).unwrap();
    let letters: String = hit
        .positions
        .iter()
        .map(|&position| path.as_bytes()[position] as char)
        .collect();
    assert_eq!(letters, "Edtsx");
    assert_eq!(hit.path, path);
}

#[test]
fn does_not_match_when_a_letter_is_missing() {
    assert!(fuzzy_match("xyz", "src/main.ts").is_none());
}

#[test]
fn does_not_match_an_empty_query() {
    assert!(fuzzy_match("  ", "src/main.ts").is_none());
}

#[test]
fn scores_a_file_whose_name_matches_above_one_that_only_matches_across_folders() {
    assert!(score("main", "src/extensions/git/main.ts") > score("main", "src/mx/a/in.ts"));
}

#[test]
fn scores_matches_at_word_starts_camel_case_included_higher() {
    assert!(score("fv", "src/FileView.tsx") > score("fv", "src/sofavx.ts"));
}

#[test]
fn prefers_the_match_in_the_file_name_over_an_earlier_one_in_the_folder() {
    let hit = fuzzy_match("ab", "a/ab").unwrap();
    assert_eq!(hit.positions, [2, 3]);
}
