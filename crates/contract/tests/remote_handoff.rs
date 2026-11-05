#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::remote_handoff::{
    PROMPT_MAX, START_WAIT_MS, fetched_ref, is_repo_handoff, job_branch, job_ref, mirror_path,
    repo_id_of, repo_slug,
};
use serde_json::{Value, json};

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

fn handoff(id: &str, name: &str, head: &str) -> Value {
    json!({"id": id, "name": name, "head": head})
}

#[test]
fn keeps_the_start_limits() {
    assert_eq!(START_WAIT_MS, 60_000);
    assert_eq!(PROMPT_MAX, 16_000);
}

#[test]
fn accepts_a_repo_handoff_with_a_valid_id_name_and_head() {
    assert!(is_repo_handoff(&handoff("app-0123456789ab", "app", HEAD)));
    assert!(is_repo_handoff(&handoff(
        "A.b_c-d-0123456789ab",
        "A.b_c-d",
        HEAD
    )));
    assert!(is_repo_handoff(&json!({
        "id": "app-0123456789ab", "name": "app", "head": HEAD, "extra": 1
    })));
}

#[test]
fn refuses_a_value_that_is_not_an_object_with_three_strings() {
    let refused = [
        Value::Null,
        json!("app"),
        json!(5),
        json!(true),
        json!([]),
        json!({}),
        json!({"id": "app-0123456789ab", "name": "app"}),
        json!({"id": "app-0123456789ab", "head": HEAD}),
        json!({"name": "app", "head": HEAD}),
        json!({"id": 1, "name": "app", "head": HEAD}),
        json!({"id": "app-0123456789ab", "name": null, "head": HEAD}),
        json!({"id": "app-0123456789ab", "name": "app", "head": 7}),
    ];
    for value in refused {
        assert!(!is_repo_handoff(&value), "{value}");
    }
}

#[test]
fn refuses_an_id_that_does_not_end_in_twelve_lower_case_hex_digits() {
    let ids = [
        "app",
        "app-",
        "app-0123456789a",
        "app-0123456789abc",
        "app-0123456789AB",
        "app-0123456789ag",
        "app0123456789ab",
        "-0123456789ab",
        "-app-0123456789ab",
        "app-0123456789ab\n",
        "app 1-0123456789ab",
        "ap\u{00e9}-0123456789ab",
        "",
    ];
    for id in ids {
        assert!(!is_repo_handoff(&handoff(id, "app", HEAD)), "{id:?}");
    }
}

#[test]
fn limits_the_name_in_an_id_to_41_characters() {
    let name = format!("a{}", "b".repeat(40));
    assert!(is_repo_handoff(&handoff(
        &format!("{name}-0123456789ab"),
        "app",
        HEAD
    )));
    let longer = format!("a{}", "b".repeat(41));
    assert!(!is_repo_handoff(&handoff(
        &format!("{longer}-0123456789ab"),
        "app",
        HEAD
    )));
}

#[test]
fn refuses_a_name_that_starts_with_a_symbol_or_has_a_bad_character() {
    let names = [
        "",
        "-app",
        ".app",
        "_app",
        "a pp",
        "a/b",
        "app\n",
        "\u{00e9}",
        "\u{0663}",
        "\u{65e5}\u{672c}",
    ];
    for name in names {
        assert!(
            !is_repo_handoff(&handoff("app-0123456789ab", name, HEAD)),
            "{name:?}"
        );
    }
}

#[test]
fn limits_the_name_to_41_characters() {
    let longest = format!("a{}", "b".repeat(40));
    assert!(is_repo_handoff(&handoff(
        "app-0123456789ab",
        &longest,
        HEAD
    )));
    let longer = format!("a{}", "b".repeat(41));
    assert!(!is_repo_handoff(&handoff(
        "app-0123456789ab",
        &longer,
        HEAD
    )));
}

#[test]
fn refuses_a_head_that_is_not_forty_lower_case_hex_digits() {
    let heads: Vec<String> = vec![
        String::new(),
        HEAD[..39].to_owned(),
        format!("{HEAD}0"),
        HEAD.to_uppercase(),
        "g123456789abcdef0123456789abcdef01234567".to_owned(),
        format!("{HEAD}\n"),
    ];
    for head in &heads {
        assert!(
            !is_repo_handoff(&handoff("app-0123456789ab", "app", head)),
            "{head:?}"
        );
    }
}

#[test]
fn makes_a_slug_from_a_name_with_runs_of_bad_characters_as_one_dash() {
    assert_eq!(repo_slug("my repo"), "my-repo");
    assert_eq!(repo_slug("my   repo"), "my-repo");
    assert_eq!(repo_slug("a/b\\c"), "a-b-c");
    assert_eq!(repo_slug("a.b_c-d"), "a.b_c-d");
    assert_eq!(repo_slug("a\u{00e9}\u{00e9}b"), "a-b");
    assert_eq!(repo_slug("a\u{1f600}b"), "a-b");
    assert_eq!(repo_slug("a\u{1f600}\u{1f600}b"), "a-b");
}

#[test]
fn strips_leading_characters_that_are_not_letters_or_digits_from_a_slug() {
    assert_eq!(repo_slug("..hidden"), "hidden");
    assert_eq!(repo_slug("-_-x"), "x");
    assert_eq!(repo_slug("  x"), "x");
    assert_eq!(repo_slug("\u{00e9}n\u{00ef}"), "n-");
    assert_eq!(repo_slug("x-"), "x-");
}

#[test]
fn falls_back_to_repo_when_a_slug_would_be_empty() {
    for name in [
        "",
        "---",
        "...",
        "  ",
        "\u{65e5}\u{672c}",
        "\u{1f600}",
        "-_.",
    ] {
        assert_eq!(repo_slug(name), "repo", "{name:?}");
    }
}

#[test]
fn cuts_a_slug_at_forty_characters_after_stripping() {
    assert_eq!(repo_slug(&"a".repeat(50)), "a".repeat(40));
    assert_eq!(repo_slug(&"a".repeat(40)), "a".repeat(40));
    assert_eq!(repo_slug(&format!("--{}", "a".repeat(45))), "a".repeat(40));
    assert_eq!(
        repo_slug(&format!("{} {}", "a".repeat(39), "b")),
        format!("{}-", "a".repeat(39))
    );
}

#[test]
fn builds_job_refs_branches_fetched_refs_and_mirror_paths() {
    assert_eq!(job_ref("j1"), "refs/ostia/jobs/j1");
    assert_eq!(job_branch("j1"), "ostia/j1");
    assert_eq!(fetched_ref("box", "j1"), "refs/remotes/ostia/box/j1");
    assert_eq!(
        mirror_path("app-0123456789ab"),
        ".ostia/node/repos/app-0123456789ab.git"
    );
}

#[test]
fn builds_a_repo_id_from_a_name_and_the_first_twelve_characters_of_the_root_commit() {
    assert_eq!(repo_id_of("app", HEAD), "app-0123456789ab");
    assert_eq!(repo_id_of("app", "abc"), "app-abc");
    assert_eq!(repo_id_of("app", ""), "app-");
    assert_eq!(repo_id_of("app", "0123456789abc"), "app-0123456789ab");
}

#[test]
fn counts_the_root_commit_cut_in_utf16_units() {
    let wide = "\u{1f600}".repeat(7);
    assert_eq!(
        repo_id_of("app", &wide),
        format!("app-{}", "\u{1f600}".repeat(6))
    );
}

#[test]
fn makes_a_repo_id_that_the_handoff_check_accepts() {
    let id = repo_id_of(&repo_slug("my repo"), HEAD);
    assert_eq!(id, "my-repo-0123456789ab");
    assert!(is_repo_handoff(&handoff(&id, "my-repo", HEAD)));
}
