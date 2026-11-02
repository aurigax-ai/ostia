#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_agents::extension_agents::{
    AGENT_TASKS_PER_MINUTE, HeldResume, REACHED_PANES_MAX, agent_name, agent_prompt,
    agent_task_limiter, continue_command, offer_label, offer_text, workspace_folder,
    workspace_id_of,
};
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use serde_json::{Value, json};

type Parser = fn(&Value) -> Option<String>;

fn held(agent: ResumableAgent, held: bool) -> HeldResume {
    HeldResume {
        resume: AgentResume {
            agent,
            id: "abc".to_owned(),
            cwd: None,
            args: Vec::new(),
        },
        held,
    }
}

#[test]
fn keeps_one_trimmed_line_and_refuses_any_control_character_enter_included() {
    assert_eq!(
        offer_text(&json!("  Work on SHOP-7  ")),
        Some("Work on SHOP-7".to_owned())
    );
    let refused = [
        json!("a\r"),
        json!("a\nb"),
        json!("a\x1b[201~"),
        json!("a\tb"),
        json!("\x7f"),
        json!(" "),
        json!(42),
    ];
    for raw in refused {
        assert_eq!(offer_text(&raw), None, "{raw}");
    }
}

#[test]
fn allows_newlines_and_tabs_but_no_other_control_character() {
    assert_eq!(
        agent_prompt(&json!("line one\n\tline two\n")),
        Some("line one\n\tline two".to_owned())
    );
    assert_eq!(agent_prompt(&json!("a\r\nb")), None);
    assert_eq!(agent_prompt(&json!("a\x1bb")), None);
}

#[test]
fn expands_the_home_folder_and_drops_anything_that_is_not_absolute() {
    let home = Path::new("/home/u");
    assert_eq!(
        workspace_folder(Some("~"), home),
        Some(PathBuf::from("/home/u"))
    );
    assert_eq!(
        workspace_folder(Some("~/shop"), home),
        Some(PathBuf::from("/home/u/shop"))
    );
    assert_eq!(
        workspace_folder(Some("/srv/shop"), home),
        Some(PathBuf::from("/srv/shop"))
    );
    assert_eq!(workspace_folder(Some("shop"), home), None);
    assert_eq!(workspace_folder(Some(""), home), None);
    assert_eq!(workspace_folder(None, home), None);
}

#[test]
fn limits_an_offer_text_a_label_and_a_prompt_to_their_maximum_in_utf16_units() {
    let cases: [(&str, Parser, usize); 3] = [
        ("offer text", offer_text, 2000),
        ("offer label", offer_label, 120),
        ("prompt", agent_prompt, 16_000),
    ];
    for (name, parse, max) in cases {
        assert!(parse(&json!("a".repeat(max))).is_some(), "{name} at max");
        assert_eq!(parse(&json!("a".repeat(max + 1))), None, "{name} over max");
        assert_eq!(parse(&json!(7)), None, "{name} not a string");
        assert_eq!(parse(&json!("")), None, "{name} empty");
    }
    assert!(offer_text(&json!("😀".repeat(1000))).is_some());
    assert_eq!(offer_text(&json!("😀".repeat(1001))), None);
}

#[test]
fn keeps_a_label_as_one_trimmed_line_like_an_offer_text() {
    assert_eq!(offer_label(&json!("  SHOP-7  ")), Some("SHOP-7".to_owned()));
    assert_eq!(offer_label(&json!("SHOP\n7")), None);
}

#[test]
fn accepts_a_manager_agent_name_and_refuses_anything_else() {
    for name in ["claude", "a", "A1._-x", &"a".repeat(64)] {
        assert_eq!(agent_name(&json!(name)), Some(name.to_owned()), "{name}");
    }
    let refused = [
        json!(""),
        json!("-x"),
        json!(".x"),
        json!("a b"),
        json!("a/b"),
        json!(&"a".repeat(65)),
        json!(null),
        json!(5),
    ];
    for raw in refused {
        assert_eq!(agent_name(&raw), None, "{raw}");
    }
}

#[test]
fn keeps_a_workspace_id_of_one_to_two_hundred_characters() {
    assert_eq!(workspace_id_of(&json!("w1")), Some("w1".to_owned()));
    assert!(workspace_id_of(&json!("a".repeat(200))).is_some());
    assert_eq!(workspace_id_of(&json!("a".repeat(201))), None);
    assert_eq!(workspace_id_of(&json!("")), None);
    assert_eq!(workspace_id_of(&json!(1)), None);
    assert_eq!(workspace_id_of(&Value::Null), None);
}

#[test]
fn allows_six_agent_tasks_a_minute_for_each_key_and_frees_them_when_the_window_ends() {
    assert_eq!(AGENT_TASKS_PER_MINUTE, 6);
    assert_eq!(REACHED_PANES_MAX, 256);
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let reader = Arc::clone(&clock);
    let limiter = agent_task_limiter(Arc::new(move || reader.load(Ordering::SeqCst)));
    for turn in 0..AGENT_TASKS_PER_MINUTE {
        assert!(limiter.take("ext").allowed, "task {turn}");
    }
    assert!(!limiter.take("ext").allowed);
    assert!(limiter.take("other").allowed);
    clock.fetch_add(59_999, Ordering::SeqCst);
    assert!(!limiter.take("ext").allowed);
    clock.fetch_add(1, Ordering::SeqCst);
    assert!(limiter.take("ext").allowed);
}

#[test]
fn continues_a_session_with_the_prompt_quoted_and_forks_it_only_when_it_is_held_and_can_fork() {
    let cases = [
        (ResumableAgent::Claude, false, "'claude' --resume abc go"),
        (
            ResumableAgent::Claude,
            true,
            "'claude' --resume abc --fork-session go",
        ),
        (ResumableAgent::Codex, false, "'codex' resume abc go"),
        (ResumableAgent::Codex, true, "'codex' fork abc go"),
        (ResumableAgent::Agy, false, "'agy' --conversation abc go"),
        (ResumableAgent::Agy, true, "'agy' --conversation abc go"),
    ];
    for (agent, is_held, expected) in cases {
        assert_eq!(
            continue_command(&held(agent, is_held), "go"),
            expected,
            "{agent:?} held {is_held}"
        );
    }
    assert_eq!(
        continue_command(&held(ResumableAgent::Codex, false), "it's here"),
        "'codex' resume abc 'it'\\''s here'"
    );
}
