#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::files::text_match::{MatchOptions, text_matcher};

const OPTS: MatchOptions = MatchOptions {
    case_sensitive: false,
    whole_word: false,
    regex: false,
};

#[test]
fn finds_a_literal_text_ignoring_case_by_default() {
    assert_eq!(
        text_matcher("a.b", &OPTS).unwrap().find_all("A.B and axb"),
        [(0, 3)]
    );
}

#[test]
fn honours_match_case_whole_word_and_regex() {
    let case = MatchOptions {
        case_sensitive: true,
        ..OPTS
    };
    assert_eq!(
        text_matcher("Note", &case).unwrap().find_all("note Note"),
        [(5, 9)]
    );
    let word = MatchOptions {
        whole_word: true,
        ..OPTS
    };
    assert_eq!(
        text_matcher("note", &word).unwrap().find_all("notes note"),
        [(6, 10)]
    );
    let regex = MatchOptions {
        regex: true,
        ..OPTS
    };
    assert_eq!(
        text_matcher("n.te", &regex).unwrap().find_all("nite note"),
        [(0, 4), (5, 9)]
    );
}

#[test]
fn gives_no_matcher_for_an_empty_query_or_an_invalid_regex() {
    assert!(text_matcher("", &OPTS).is_none());
    let regex = MatchOptions {
        regex: true,
        ..OPTS
    };
    assert!(text_matcher("(", &regex).is_none());
}

#[test]
fn skips_empty_matches() {
    let regex = MatchOptions {
        regex: true,
        ..OPTS
    };
    assert_eq!(
        text_matcher("x*", &regex).unwrap().find_all("axa"),
        [(1, 2)]
    );
}

#[test]
fn a_literal_query_does_not_read_regex_syntax() {
    assert_eq!(
        text_matcher("a+b", &OPTS).unwrap().find_all("a+b aab"),
        [(0, 3)]
    );
    assert_eq!(
        text_matcher("(x)", &OPTS).unwrap().find_all("(x) x"),
        [(0, 3)]
    );
}

#[test]
fn ranges_count_utf16_units() {
    assert_eq!(
        text_matcher("a", &OPTS).unwrap().find_all("\u{1F600}a"),
        [(2, 3)]
    );
    assert_eq!(
        text_matcher("\u{1F600}", &OPTS)
            .unwrap()
            .find_all("a\u{1F600}\u{1F600}"),
        [(1, 3), (3, 5)]
    );
    assert_eq!(
        text_matcher("b", &OPTS)
            .unwrap()
            .find_all("\u{e9}\u{6587}b"),
        [(2, 3)]
    );
}

#[test]
fn matches_do_not_overlap() {
    assert_eq!(
        text_matcher("aa", &OPTS).unwrap().find_all("aaaa"),
        [(0, 2), (2, 4)]
    );
}

#[test]
fn ignoring_case_folds_non_ascii_letters() {
    assert_eq!(
        text_matcher("\u{e9}", &OPTS).unwrap().find_all("\u{c9}"),
        [(0, 1)]
    );
    let case = MatchOptions {
        case_sensitive: true,
        ..OPTS
    };
    assert!(
        text_matcher("\u{e9}", &case)
            .unwrap()
            .find_all("\u{c9}")
            .is_empty()
    );
}

#[test]
fn whole_word_wraps_a_regex_with_alternatives_as_one_group() {
    let both = MatchOptions {
        whole_word: true,
        regex: true,
        ..OPTS
    };
    assert_eq!(
        text_matcher("foo|bar", &both)
            .unwrap()
            .find_all("foobar foo bar"),
        [(7, 10), (11, 14)]
    );
}

#[test]
fn whole_word_boundaries_are_ascii_like_javascript() {
    let word = MatchOptions {
        whole_word: true,
        ..OPTS
    };
    assert_eq!(
        text_matcher("caf", &word).unwrap().find_all("caf\u{e9}"),
        [(0, 3)]
    );
    assert_eq!(
        text_matcher("caf", &word).unwrap().find_all("caf_ caf"),
        [(5, 8)]
    );
}

#[test]
fn a_regex_digit_class_is_ascii_only() {
    let regex = MatchOptions {
        regex: true,
        ..OPTS
    };
    assert_eq!(
        text_matcher("\\d", &regex).unwrap().find_all("\u{663}1"),
        [(1, 2)]
    );
    assert_eq!(
        text_matcher("\\w+", &regex).unwrap().find_all("\u{e9}ab"),
        [(1, 3)]
    );
}

#[test]
fn a_regex_dot_stops_at_every_javascript_line_end() {
    let regex = MatchOptions {
        regex: true,
        ..OPTS
    };
    assert_eq!(
        text_matcher("a.b", &regex)
            .unwrap()
            .find_all("a\u{2028}b a\u{2029}b a\rb a-b"),
        [(12, 15)]
    );
}

#[test]
fn one_matcher_gives_the_same_answer_for_each_line() {
    let matcher = text_matcher("a", &OPTS).unwrap();
    assert_eq!(matcher.find_all("aba"), [(0, 1), (2, 3)]);
    assert_eq!(matcher.find_all("aba"), [(0, 1), (2, 3)]);
    assert!(matcher.find_all("xyz").is_empty());
    assert!(matcher.find_all("").is_empty());
}
