use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_model::assist::assist_composer::{
    ComposerMode, ComposerState, DiffPart, LatestRequest, composer_mode_for, natural_command_query,
    word_diff,
};

fn base() -> ComposerState {
    ComposerState {
        agent: false,
        idle_prompt: false,
        input_ready: true,
        command_ready: true,
    }
}

fn part(at: usize, text: &str, changed: bool) -> DiffPart {
    DiffPart {
        at,
        text: text.to_owned(),
        changed,
    }
}

fn changed_texts(parts: &[DiffPart]) -> Vec<&str> {
    parts
        .iter()
        .filter(|p| p.changed)
        .map(|p| p.text.as_str())
        .collect()
}

#[test]
fn picks_the_agent_composer_while_an_agent_runs_and_input_assist_is_ready() {
    let agent = ComposerState {
        agent: true,
        ..base()
    };
    assert_eq!(composer_mode_for(&agent), Some(ComposerMode::Agent));
    let not_ready = ComposerState {
        agent: true,
        input_ready: false,
        ..base()
    };
    assert_eq!(composer_mode_for(&not_ready), None);
}

#[test]
fn picks_the_command_composer_at_an_idle_shell_prompt() {
    let idle = ComposerState {
        idle_prompt: true,
        ..base()
    };
    assert_eq!(composer_mode_for(&idle), Some(ComposerMode::Shell));
    let not_ready = ComposerState {
        idle_prompt: true,
        command_ready: false,
        ..base()
    };
    assert_eq!(composer_mode_for(&not_ready), None);
}

#[test]
fn opens_nothing_while_a_non_agent_command_runs() {
    assert_eq!(composer_mode_for(&base()), None);
}

#[test]
fn an_agent_decides_the_mode_even_when_the_prompt_is_idle() {
    let both = ComposerState {
        agent: true,
        idle_prompt: true,
        input_ready: false,
        command_ready: true,
    };
    assert_eq!(composer_mode_for(&both), None);
    let both_ready = ComposerState {
        input_ready: true,
        ..both
    };
    assert_eq!(composer_mode_for(&both_ready), Some(ComposerMode::Agent));
}

#[test]
fn marks_only_the_words_the_correction_changed() {
    let parts = word_diff("fix teh bug in teh parser", "fix the bug in the parser");
    assert_eq!(changed_texts(&parts), vec!["the", "the"]);
    let joined: String = parts.iter().map(|p| p.text.as_str()).collect();
    assert_eq!(joined, "fix the bug in the parser");
}

#[test]
fn reports_no_change_for_identical_text() {
    assert_eq!(
        word_diff("same text", "same text"),
        vec![part(0, "same text", false)]
    );
}

#[test]
fn leaves_the_spaces_inside_an_added_run_unmarked() {
    assert_eq!(
        word_diff("hello world", "hello brave new world"),
        vec![
            part(0, "hello ", false),
            part(6, "brave", true),
            part(11, " ", false),
            part(12, "new", true),
            part(15, " world", false),
        ]
    );
    assert_eq!(
        changed_texts(&word_diff("a b c", "a x y c")),
        vec!["x", "y"]
    );
}

#[test]
fn marks_a_single_fix_inside_a_long_text() {
    let tail = " word".repeat(700);
    let parts = word_diff(&format!("teh{tail}"), &format!("the{tail}"));
    assert_eq!(changed_texts(&parts), vec!["the"]);
}

#[test]
fn keeps_offsets_into_the_corrected_text() {
    assert_eq!(
        word_diff("a b", "a c"),
        vec![part(0, "a ", false), part(2, "c", true)]
    );
}

#[test]
fn marks_every_word_of_text_added_to_an_empty_one() {
    assert_eq!(
        word_diff("", "new text"),
        vec![
            part(0, "new", true),
            part(3, " ", false),
            part(4, "text", true)
        ]
    );
}

#[test]
fn marks_the_whole_corrected_text_when_the_diff_needs_more_than_600_edits() {
    let before = (0..700)
        .map(|i| format!("x{i}"))
        .collect::<Vec<_>>()
        .join(" ");
    let after = (0..700)
        .map(|i| format!("y{i}"))
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(word_diff(&before, &after), vec![part(0, &after, true)]);
}

#[test]
fn counts_offsets_in_utf16_units_like_the_corrected_text_in_the_editor() {
    assert_eq!(
        word_diff("a \u{1F600}", "a \u{1F600} b"),
        vec![part(0, "a \u{1F600} ", false), part(5, "b", true)]
    );
}

#[tokio::test(start_paused = true)]
async fn aborts_the_previous_request_and_only_runs_the_latest_after_the_delay() {
    let latest = LatestRequest::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    for value in ["first", "second"] {
        let seen = Arc::clone(&seen);
        latest.run(Duration::from_millis(100), move |signal| async move {
            seen.lock().unwrap().push((value, signal));
        });
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    tokio::task::yield_now().await;
    let names: Vec<&str> = seen.lock().unwrap().iter().map(|(name, _)| *name).collect();
    assert_eq!(names, vec!["second"]);
    latest.run(Duration::from_millis(100), |_signal| async {});
    assert!(seen.lock().unwrap()[0].1.is_cancelled());
    latest.cancel();
}

#[tokio::test(start_paused = true)]
async fn runs_nothing_after_cancel_and_nothing_before_the_delay() {
    let latest = LatestRequest::new();
    let ran = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&ran);
    latest.run(Duration::from_millis(100), move |_signal| async move {
        *counter.lock().unwrap() += 1;
    });
    tokio::time::sleep(Duration::from_millis(99)).await;
    tokio::task::yield_now().await;
    assert_eq!(*ran.lock().unwrap(), 0);
    latest.cancel();
    tokio::time::sleep(Duration::from_millis(500)).await;
    tokio::task::yield_now().await;
    assert_eq!(*ran.lock().unwrap(), 0);
}

#[tokio::test(start_paused = true)]
async fn cancel_aborts_the_signal_of_a_request_that_already_started() {
    let latest = LatestRequest::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    latest.run(Duration::from_millis(10), move |signal| async move {
        sink.lock().unwrap().push(signal);
    });
    tokio::time::sleep(Duration::from_millis(10)).await;
    tokio::task::yield_now().await;
    assert!(!seen.lock().unwrap()[0].is_cancelled());
    latest.cancel();
    assert!(seen.lock().unwrap()[0].is_cancelled());
}

#[test]
fn reads_a_query_after_a_leading_hash_and_space() {
    assert_eq!(
        natural_command_query("# list big files "),
        Some("list big files".to_owned())
    );
}

#[test]
fn ignores_short_queries_and_plain_commands() {
    assert_eq!(natural_command_query("# ls"), None);
    assert_eq!(natural_command_query("ls -la"), None);
    assert_eq!(natural_command_query("#nospace here"), None);
}

#[test]
fn takes_a_query_of_exactly_three_characters_and_one_that_spans_lines() {
    assert_eq!(natural_command_query("# abc"), Some("abc".to_owned()));
    assert_eq!(
        natural_command_query("# list\nfiles"),
        Some("list\nfiles".to_owned())
    );
}

#[test]
fn counts_the_js_whitespace_set_after_the_hash() {
    assert_eq!(
        natural_command_query("#\u{FEFF}find it"),
        Some("find it".to_owned())
    );
    assert_eq!(
        natural_command_query("#\tfind it"),
        Some("find it".to_owned())
    );
    assert_eq!(natural_command_query("#\u{85}find it"), None);
}
