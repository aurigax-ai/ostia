#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use ostia_cli::common::args::{
    FlagError, FlagProblem, FlagSpec, ParsedArgs, UnknownFlags, parse_args, parse_timeout_seconds,
};

const RUN: FlagSpec = FlagSpec {
    values: &[("name", "--name"), ("cwd", "--cwd")],
    lists: &[],
    booleans: &[],
    unknown: UnknownFlags::Refuse,
};

fn problem(argv: &[&str], spec: &FlagSpec) -> FlagError {
    match parse_args(argv, spec) {
        Err(err) => err,
        Ok(_) => panic!("expected a FlagError for {argv:?}"),
    }
}

fn parsed(argv: &[&str], spec: &FlagSpec) -> ParsedArgs {
    parse_args(argv, spec).unwrap()
}

fn words(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn map<V: Clone>(pairs: &[(&str, V)]) -> BTreeMap<String, V> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[test]
fn reads_a_value_flag_before_between_and_after_the_positionals() {
    for argv in [
        &["--name", "web", "pnpm dev", "extra"][..],
        &["pnpm dev", "--name", "web", "extra"][..],
        &["pnpm dev", "extra", "--name", "web"][..],
    ] {
        let result = parsed(argv, &RUN);
        assert_eq!(result.positional, words(&["pnpm dev", "extra"]), "{argv:?}");
        assert_eq!(
            result.values,
            map(&[("name", "web".to_owned())]),
            "{argv:?}"
        );
    }
}

#[test]
fn accepts_flag_equals_value_and_keeps_the_last_value_of_a_repeated_flag() {
    let result = parsed(&["--name=web", "--name", "api"], &RUN);
    assert_eq!(result.values.get("name").map(String::as_str), Some("api"));
}

#[test]
fn takes_whatever_follows_a_value_flag_as_its_value_even_a_flag_or_a_lone_dash() {
    assert_eq!(
        parsed(&["--name", "--cwd"], &RUN).values,
        map(&[("name", "--cwd".to_owned())])
    );
    assert_eq!(
        parsed(&["--name", "-"], &RUN).values,
        map(&[("name", "-".to_owned())])
    );
}

#[test]
fn collects_a_repeated_list_flag_in_order_and_starts_each_parse_empty() {
    let spec = FlagSpec {
        lists: &[("choice", "--choice")],
        ..FlagSpec::default()
    };
    assert_eq!(
        parsed(&["--choice", "lint", "q", "--choice", "unit"], &spec).lists["choice"],
        words(&["lint", "unit"])
    );
    assert_eq!(parsed(&["q"], &spec).lists["choice"], Vec::<String>::new());
}

#[test]
fn reports_each_boolean_flag_as_true_or_false() {
    let spec = FlagSpec {
        booleans: &[("json", "--json"), ("all", "--all")],
        ..FlagSpec::default()
    };
    assert_eq!(
        parsed(&["list", "--json"], &spec).booleans,
        map(&[("json", true), ("all", false)])
    );
}

#[test]
fn reads_a_short_alias_and_a_group_of_short_booleans() {
    let spec = FlagSpec {
        values: &[("depth", "-d, --depth")],
        booleans: &[("interactive", "-i"), ("compact", "-c")],
        ..FlagSpec::default()
    };
    let result = parsed(&["-ic", "-d", "3"], &spec);
    assert_eq!(result.values, map(&[("depth", "3".to_owned())]));
    assert_eq!(
        result.booleans,
        map(&[("interactive", true), ("compact", true)])
    );
}

#[test]
fn refuses_an_unknown_flag_by_the_name_the_caller_wrote() {
    let err = problem(&["pnpm dev", "--nmae", "web"], &RUN);
    assert_eq!(err.problem, FlagProblem::Unknown);
    assert_eq!(err.flag, "--nmae");
    assert_eq!(err.to_string(), "unknown flag --nmae");
    assert_eq!(problem(&["-x"], &RUN).to_string(), "unknown flag -x");
}

#[test]
fn refuses_a_value_flag_with_nothing_after_it() {
    let err = problem(&["pnpm dev", "--cwd"], &RUN);
    assert_eq!(err.problem, FlagProblem::MissingValue);
    assert_eq!(err.flag, "--cwd");
    assert_eq!(err.to_string(), "--cwd needs a value");
    let depth = FlagSpec {
        values: &[("depth", "-d, --depth")],
        ..FlagSpec::default()
    };
    assert_eq!(
        problem(&["-d"], &depth).to_string(),
        "--depth needs a value"
    );
}

#[test]
fn keeps_a_lone_dash_and_a_negative_number_as_positionals() {
    assert_eq!(
        parsed(&["waiting", "-"], &RUN).positional,
        words(&["waiting", "-"])
    );
    assert_eq!(
        parsed(&["size", "-1", "-0.5", "-2e3"], &RUN).positional,
        words(&["size", "-1", "-0.5", "-2e3"])
    );
}

#[test]
fn passes_everything_after_dash_dash_through_untouched_flags_included() {
    let result = parsed(&["--name", "web", "--", "--cwd", "-x", "--", "last"], &RUN);
    assert_eq!(result.positional, words(&["--cwd", "-x", "--", "last"]));
    assert_eq!(result.values, map(&[("name", "web".to_owned())]));
}

const SEND: FlagSpec = FlagSpec {
    values: &[],
    lists: &[],
    booleans: &[("enter", "--enter")],
    unknown: UnknownFlags::Keep,
};

#[test]
fn with_unknown_keep_keeps_unknown_flags_as_words_in_the_order_they_were_written() {
    let result = parsed(
        &["git", "commit", "-m", "fix: -1 off", "--amend", "--enter"],
        &SEND,
    );
    assert_eq!(
        result.positional,
        words(&["git", "commit", "-m", "fix: -1 off", "--amend"])
    );
    assert!(result.booleans["enter"]);
}

#[test]
fn with_unknown_keep_keeps_a_word_that_only_starts_with_a_dash_such_as_a_bullet_list() {
    assert_eq!(
        parsed(&["claude", "- step one\n- step two"], &SEND).positional,
        words(&["claude", "- step one\n- step two"])
    );
}

#[test]
fn with_unknown_keep_drops_only_the_dash_dash_that_ends_the_flags() {
    let result = parsed(&["-x", "--", "--enter", "--"], &SEND);
    assert_eq!(result.positional, words(&["-x", "--enter", "--"]));
    assert!(!result.booleans["enter"]);
}

#[test]
fn with_unknown_keep_still_refuses_a_value_flag_with_nothing_after_it() {
    let spec = FlagSpec {
        values: &[("pane", "--pane")],
        unknown: UnknownFlags::Keep,
        ..FlagSpec::default()
    };
    assert_eq!(
        problem(&["-x", "--pane"], &spec).to_string(),
        "--pane needs a value"
    );
}

#[test]
fn reports_the_first_unknown_flag_when_there_are_several() {
    assert_eq!(problem(&["-x", "--y"], &RUN).flag, "-x");
}

#[test]
fn takes_flags_after_dash_dash_as_positionals_when_unknown_flags_are_refused() {
    assert_eq!(parsed(&["--", "--zzz"], &RUN).positional, words(&["--zzz"]));
}

#[test]
fn parse_timeout_seconds_has_no_timeout_when_the_flag_is_absent() {
    assert_eq!(parse_timeout_seconds(None).unwrap(), None);
}

#[test]
fn parse_timeout_seconds_reads_seconds_the_way_javascript_reads_a_number() {
    for (raw, seconds) in [
        ("30", 30.0),
        ("1.5", 1.5),
        (" 5 ", 5.0),
        ("1e3", 1000.0),
        ("0x10", 16.0),
    ] {
        assert_eq!(
            parse_timeout_seconds(Some(raw)).unwrap(),
            Some(seconds),
            "{raw:?}"
        );
    }
}

#[test]
fn parse_timeout_seconds_refuses_zero_negative_empty_and_non_finite_values() {
    for raw in ["0", "-1", "", "abc", "12abc", "Infinity", "NaN"] {
        assert_eq!(
            parse_timeout_seconds(Some(raw)).unwrap_err().to_string(),
            format!("--timeout expects seconds, got '{raw}'"),
            "{raw:?}"
        );
    }
}
