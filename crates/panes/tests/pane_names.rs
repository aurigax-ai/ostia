#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_panes::pane_names::{Claim, PaneName, PaneNames, parse_desc, parse_name};
use serde_json::{Value, json};

const NAME_RULE: &str = "name is 1-40 lowercase letters, digits, '-' or '.', starting and ending with a letter or digit";

fn held(name: &str, desc: Option<&str>) -> Claim {
    Claim::Held(PaneName {
        name: name.to_owned(),
        desc: desc.map(str::to_owned),
    })
}

fn claim(names: &PaneNames, pane: &str, name: &str, desc: Option<&str>) -> Claim {
    let desc = desc.map(|text| json!(text));
    names.claim_name(pane, &json!(name), desc.as_ref())
}

fn is_held(claim: &Claim) -> bool {
    matches!(claim, Claim::Held(_))
}

#[test]
fn takes_a_short_lowercase_slug_and_refuses_anything_else_upper_case_included() {
    assert_eq!(
        parse_name(&json!("coordinator.2")),
        Ok("coordinator.2".to_owned())
    );
    let long = "x".repeat(41);
    let bad: Vec<Value> = vec![
        json!(""),
        json!("Coordinator"),
        json!(" boss"),
        json!("a b"),
        json!("-x"),
        json!("x-"),
        json!("é"),
        json!("a/b"),
        json!(long),
        json!(5),
        json!(null),
        json!("a\nb"),
        json!("ab\n"),
    ];
    for raw in bad {
        assert!(parse_name(&raw).is_err(), "{raw}");
    }
}

#[test]
fn refuses_a_name_that_reads_as_a_pane_id_so_it_cannot_shadow_an_id_prefix() {
    assert!(parse_name(&json!("3f6a7ced")).is_err());
    assert!(parse_name(&json!("3f6a7ced-1c2d")).is_err());
    assert_eq!(parse_name(&json!("3f6a7c")), Ok("3f6a7c".to_owned()));
    assert_eq!(parse_name(&json!("3f6a7cedz")), Ok("3f6a7cedz".to_owned()));
}

#[test]
fn takes_one_line_of_description_and_refuses_control_and_format_characters() {
    assert_eq!(parse_desc(None), Ok(None));
    assert_eq!(
        parse_desc(Some(&json!("  builds #1365 "))),
        Ok(Some("builds #1365".to_owned()))
    );
    assert_eq!(parse_desc(Some(&json!("   "))), Ok(None));
    let long = "x".repeat(201);
    let bad: Vec<Value> = vec![
        json!("a\nb"),
        json!("a\u{1b}[31m"),
        json!("a\u{202e}b"),
        json!(long),
        json!(3),
    ];
    for raw in bad {
        assert!(parse_desc(Some(&raw)).is_err(), "{raw}");
    }
}

#[test]
fn has_one_live_holder_per_name_and_refuses_a_second_pane_without_taking_it_over() {
    let names = PaneNames::new();
    assert_eq!(
        claim(&names, "p1", "boss", Some("plans")),
        held("boss", Some("plans"))
    );
    assert_eq!(
        claim(&names, "p2", "boss", None),
        Claim::NameTaken {
            name: "boss".to_owned(),
            holder: "p1".to_owned()
        }
    );
    assert_eq!(names.pane_named("boss").as_deref(), Some("p1"));
    assert_eq!(names.name_of("p2"), None);
}

#[test]
fn refuses_a_name_held_anywhere_whatever_the_claimer_reaches_until_the_holder_drops_it() {
    let names = PaneNames::new();
    claim(&names, "far-1", "boss", None);
    assert!(matches!(
        claim(&names, "far-2", "boss", None),
        Claim::NameTaken { holder, .. } if holder == "far-1"
    ));
    names.drop_name("far-1");
    assert!(is_held(&claim(&names, "far-2", "boss", None)));
    assert_eq!(names.pane_named("boss").as_deref(), Some("far-2"));
}

#[test]
fn lets_the_holder_claim_again_which_frees_its_old_name() {
    let names = PaneNames::new();
    claim(&names, "p1", "boss", None);
    assert!(is_held(&claim(&names, "p1", "boss", Some("again"))));
    claim(&names, "p1", "lead", None);
    assert_eq!(names.pane_named("boss"), None);
    assert!(is_held(&claim(&names, "p2", "boss", None)));
}

#[test]
fn clears_a_name_and_frees_it() {
    let names = PaneNames::new();
    claim(&names, "p1", "boss", None);
    assert!(names.drop_name("p1"));
    assert!(!names.drop_name("p1"));
    assert_eq!(names.pane_named("boss"), None);
}

#[test]
fn drops_the_names_of_the_panes_a_predicate_picks_workspace_closed() {
    let names = PaneNames::new();
    claim(&names, "p1", "one", None);
    claim(&names, "p2", "two", None);
    names.drop_names_where(|pane_id| pane_id == "p1");
    assert_eq!(names.pane_named("one"), None);
    assert_eq!(names.pane_named("two").as_deref(), Some("p2"));
}

#[test]
fn drops_the_name_when_the_agent_session_changes_and_keeps_it_for_the_same_session() {
    let names = PaneNames::new();
    names.note_agent_session("p1", "claude", "s-1");
    claim(&names, "p1", "boss", None);
    names.note_agent_session("p1", "claude", "s-1");
    assert_eq!(names.pane_named("boss").as_deref(), Some("p1"));
    names.note_agent_session("p1", "claude", "s-2");
    assert_eq!(names.pane_named("boss"), None);
}

#[test]
fn drops_the_name_when_the_agent_kind_changes() {
    let names = PaneNames::new();
    names.note_agent_session("p1", "claude", "same");
    claim(&names, "p1", "boss", None);
    names.note_agent_session("p1", "codex", "same");
    assert_eq!(names.pane_named("boss"), None);
}

#[test]
fn keeps_each_claim_with_its_description_and_leaves_none_for_blank_text() {
    let names = PaneNames::new();
    assert_eq!(claim(&names, "p1", "boss", Some("   ")), held("boss", None));
    assert_eq!(
        names.name_of("p1"),
        Some(PaneName {
            name: "boss".to_owned(),
            desc: None
        })
    );
    assert_eq!(
        claim(&names, "p1", "boss", Some(" plans ")),
        held("boss", Some("plans"))
    );
    assert_eq!(
        names.name_of("p1").and_then(|entry| entry.desc).as_deref(),
        Some("plans")
    );
}

#[test]
fn says_what_is_wrong_in_the_ts_words_and_checks_the_name_before_the_description() {
    assert_eq!(parse_name(&json!(5)), Err("name must be text".to_owned()));
    assert_eq!(parse_name(&json!("Boss")), Err(NAME_RULE.to_owned()));
    assert_eq!(
        parse_name(&json!("3f6a7ced")),
        Err("name looks like a pane id; add a letter that is not a hex digit".to_owned())
    );
    assert_eq!(
        parse_desc(Some(&json!(3))),
        Err("description must be text".to_owned())
    );
    assert_eq!(
        parse_desc(Some(&json!(null))),
        Err("description must be text".to_owned())
    );
    assert_eq!(
        parse_desc(Some(&json!("x".repeat(201)))),
        Err("description is at most 200 characters".to_owned())
    );
    assert_eq!(
        parse_desc(Some(&json!("a\nb"))),
        Err("description is one line without control or format characters".to_owned())
    );
    let names = PaneNames::new();
    assert_eq!(
        names.claim_name("p1", &json!("Boss"), Some(&json!(3))),
        Claim::BadName(NAME_RULE.to_owned())
    );
    assert_eq!(
        names.claim_name("p1", &json!("boss"), Some(&json!(3))),
        Claim::BadDesc("description must be text".to_owned())
    );
    assert_eq!(names.pane_named("boss"), None);
}

#[test]
fn keeps_a_held_name_when_the_next_claim_of_the_same_pane_is_refused() {
    let names = PaneNames::new();
    claim(&names, "p1", "boss", None);
    claim(&names, "p2", "lead", None);
    assert!(matches!(
        claim(&names, "p1", "lead", None),
        Claim::NameTaken { .. }
    ));
    assert!(matches!(
        names.claim_name("p1", &json!("Bad"), None),
        Claim::BadName(_)
    ));
    assert_eq!(names.pane_named("boss").as_deref(), Some("p1"));
    assert_eq!(names.pane_named("lead").as_deref(), Some("p2"));
}

#[test]
fn counts_the_name_and_description_limits_at_the_edge_in_utf16_units() {
    assert_eq!(parse_name(&json!("x".repeat(40))), Ok("x".repeat(40)));
    assert_eq!(parse_name(&json!("3f6a7ce")), Ok("3f6a7ce".to_owned()));
    assert_eq!(
        parse_desc(Some(&json!("x".repeat(200)))),
        Ok(Some("x".repeat(200)))
    );
    assert_eq!(
        parse_desc(Some(&json!("😀".repeat(100)))),
        Ok(Some("😀".repeat(100)))
    );
    assert!(parse_desc(Some(&json!("😀".repeat(101)))).is_err());
}

#[test]
fn trims_the_description_as_js_does_which_takes_the_byte_order_mark_and_line_separator() {
    assert_eq!(
        parse_desc(Some(&json!("\u{feff}plans\u{feff}"))),
        Ok(Some("plans".to_owned()))
    );
    assert_eq!(
        parse_desc(Some(&json!("plans\u{2028}"))),
        Ok(Some("plans".to_owned()))
    );
    assert!(parse_desc(Some(&json!("pl\u{2028}ans"))).is_err());
    assert!(parse_desc(Some(&json!("\u{85}plans"))).is_err());
}

#[test]
fn forgets_the_agent_session_when_the_name_drops() {
    let names = PaneNames::new();
    names.note_agent_session("p1", "claude", "s-1");
    claim(&names, "p1", "boss", None);
    names.drop_name("p1");
    claim(&names, "p1", "boss", None);
    names.note_agent_session("p1", "claude", "s-2");
    assert_eq!(names.pane_named("boss").as_deref(), Some("p1"));
}

#[test]
fn forgets_every_name_and_session_at_once() {
    let names = PaneNames::new();
    names.note_agent_session("p1", "claude", "s-1");
    claim(&names, "p1", "one", None);
    claim(&names, "p2", "two", None);
    names.forget_names();
    assert_eq!(names.pane_named("one"), None);
    assert_eq!(names.name_of("p2"), None);
    claim(&names, "p1", "one", None);
    names.note_agent_session("p1", "claude", "s-9");
    assert_eq!(names.pane_named("one").as_deref(), Some("p1"));
}

#[test]
fn asks_the_predicate_only_about_panes_that_hold_a_name() {
    let names = PaneNames::new();
    claim(&names, "p1", "one", None);
    let asked = std::sync::Mutex::new(Vec::new());
    names.drop_names_where(|pane_id| {
        asked.lock().unwrap().push(pane_id.to_owned());
        false
    });
    assert_eq!(asked.into_inner().unwrap(), vec!["p1".to_owned()]);
}
