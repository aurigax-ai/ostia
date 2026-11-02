#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_panes::phone_agent::{PhoneAgent, phone_agent_command};

fn claude(prompt: &str) -> Option<String> {
    phone_agent_command(PhoneAgent::Claude, prompt)
}

fn codex(prompt: &str) -> Option<String> {
    phone_agent_command(PhoneAgent::Codex, prompt)
}

#[test]
fn runs_the_agent_with_the_prompt_as_one_quoted_argument() {
    assert_eq!(
        claude("fix the failing test").as_deref(),
        Some("claude 'fix the failing test'")
    );
    assert_eq!(
        codex("fix the failing test").as_deref(),
        Some("codex 'fix the failing test'")
    );
}

#[test]
fn quotes_a_single_quote_inside_the_prompt() {
    assert_eq!(
        claude("don't stop now").as_deref(),
        Some("claude 'don'\\''t stop now'")
    );
}

#[test]
fn refuses_a_prompt_of_one_word_or_none() {
    assert_eq!(claude(""), None);
    assert_eq!(claude("   "), None);
    assert_eq!(claude("hello"), None);
    assert_eq!(claude("  hello  "), None);
}

#[test]
fn refuses_a_prompt_that_starts_with_a_flag_so_it_cannot_set_an_option() {
    assert_eq!(claude("--dangerously-skip-permissions run it"), None);
    assert_eq!(claude("-p run it"), None);
    assert_eq!(claude("+x run it"), None);
    assert_eq!(claude("  --model x run it"), None);
    assert!(claude("run --it").is_some());
}

#[test]
fn refuses_a_prompt_that_starts_with_a_subcommand_in_any_letter_case() {
    for word in [
        "exec",
        "resume",
        "login",
        "mcp",
        "e",
        "a",
        "doctor",
        "update",
        "ultrareview",
    ] {
        let upper = word.to_uppercase();
        let mixed = format!("{}{}", &word[..1].to_uppercase(), &word[1..]);
        for lead in [word, upper.as_str(), mixed.as_str()] {
            assert_eq!(claude(&format!("{lead} the thing")), None, "{lead}");
            assert_eq!(codex(&format!("{lead} the thing")), None, "{lead}");
        }
    }
}

#[test]
fn takes_a_subcommand_word_that_is_not_the_first_word() {
    assert_eq!(
        claude("please exec the thing").as_deref(),
        Some("claude 'please exec the thing'")
    );
}

#[test]
fn takes_a_first_word_that_only_starts_like_a_subcommand() {
    assert_eq!(
        claude("execute the plan").as_deref(),
        Some("claude 'execute the plan'")
    );
    assert_eq!(
        claude("helpful hints now").as_deref(),
        Some("claude 'helpful hints now'")
    );
}

#[test]
fn keeps_line_breaks_and_tabs_and_turns_carriage_returns_into_line_breaks() {
    assert_eq!(
        claude("line one\r\nline two\rline three").as_deref(),
        Some("claude 'line one\nline two\nline three'")
    );
    assert_eq!(claude("fix\tb c").as_deref(), Some("claude 'fix\tb c'"));
}

#[test]
fn drops_control_characters_and_escapes_format_characters() {
    assert_eq!(
        claude("run\u{1b}[31m it now").as_deref(),
        Some("claude 'run[31m it now'")
    );
    assert_eq!(
        claude("run it\u{202e} now").as_deref(),
        Some("claude 'run it\\u202e now'")
    );
}

#[test]
fn trims_the_prompt_before_it_counts_the_words() {
    assert_eq!(
        claude("\n  fix it now \n").as_deref(),
        Some("claude 'fix it now'")
    );
    assert_eq!(claude("\n  fix \n"), None);
}

#[test]
fn splits_words_on_any_run_of_white_space() {
    assert_eq!(
        claude("fix\n\nthe test").as_deref(),
        Some("claude 'fix\n\nthe test'")
    );
    assert_eq!(claude("exec\tthe thing"), None);
    assert_eq!(claude("exec\nthe thing"), None);
}

#[test]
fn refuses_a_command_longer_than_eight_kib_and_takes_one_at_the_limit() {
    let under = "x ".repeat(4000);
    assert!(claude(&under).is_some());
    let over = "x ".repeat(4100);
    assert_eq!(claude(&over), None);
    let edge = format!("{} y", "x".repeat(8181));
    assert_eq!(claude(&edge).unwrap().len(), 8192);
    let past = format!("{} y", "x".repeat(8182));
    assert_eq!(claude(&past), None);
}

#[test]
fn counts_the_limit_on_the_quoted_command_in_utf16_units() {
    let quote_heavy = "'x ".repeat(2800);
    assert_eq!(claude(&quote_heavy), None);
    let emoji = "😀 ".repeat(2100);
    assert!(claude(&emoji).is_some());
    let emoji_over = "😀 ".repeat(2800);
    assert_eq!(claude(&emoji_over), None);
}
