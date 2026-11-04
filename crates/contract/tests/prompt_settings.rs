#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::prompt_settings::separator_text;
use ostia_contract::prompt_settings::{
    DEFAULT_PROMPT_CHIPS, MAX_PROMPT_CHIPS, PromptSettings, PromptStyle, is_prompt_chip_id,
    parse_prompt_chips, parse_prompt_settings,
};
use ostia_contract::pty_api::PromptSeparator;
use serde_json::{Value, json};

fn default_chips() -> Vec<String> {
    DEFAULT_PROMPT_CHIPS
        .iter()
        .map(|id| (*id).to_owned())
        .collect()
}

fn strings(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

#[test]
fn accepts_core_chips_and_extension_chip_ids_only() {
    assert!(is_prompt_chip_id(&json!("cwd")));
    assert!(is_prompt_chip_id(&json!("git.branch")));
    assert!(is_prompt_chip_id(&json!("my-ext.diff-stats")));
    assert!(!is_prompt_chip_id(&json!("git")));
    assert!(!is_prompt_chip_id(&json!("Git.Branch")));
    assert!(!is_prompt_chip_id(&json!("git.branch.name")));
    assert!(!is_prompt_chip_id(&json!("__proto__")));
    assert!(!is_prompt_chip_id(&json!(3)));
}

#[test]
fn keeps_the_order_drops_unknown_ids_and_duplicates() {
    assert_eq!(
        parse_prompt_chips(&json!(["time24", "nope", "cwd", "git.branch", "cwd", 7])),
        strings(&["time24", "cwd", "git.branch"])
    );
}

#[test]
fn keeps_an_empty_list_and_falls_back_to_the_default_for_a_non_list() {
    assert_eq!(parse_prompt_chips(&json!([])), Vec::<String>::new());
    assert_eq!(parse_prompt_chips(&json!("cwd")), default_chips());
}

#[test]
fn caps_the_list_length() {
    let many: Vec<String> = (0..MAX_PROMPT_CHIPS + 5)
        .map(|i| format!("ext.chip{i}"))
        .collect();
    assert_eq!(parse_prompt_chips(&json!(many)).len(), MAX_PROMPT_CHIPS);
}

#[test]
fn defaults_to_the_shell_prompt_with_warps_chip_order_limited_to_what_ostia_fills() {
    assert_eq!(
        parse_prompt_settings(&Value::Null),
        PromptSettings::default()
    );
    assert_eq!(
        PromptSettings::default(),
        PromptSettings {
            style: PromptStyle::Shell,
            chips: strings(&[
                "conda",
                "virtualenv",
                "node",
                "cwd",
                "git.branch",
                "git.diff-stats"
            ]),
            same_line: false,
            separator: PromptSeparator::None,
        }
    );
}

#[test]
fn validates_each_field_on_its_own() {
    assert_eq!(
        parse_prompt_settings(&json!({
            "style": "ostia", "chips": ["host"], "sameLine": "yes", "separator": ">"
        })),
        PromptSettings {
            style: PromptStyle::Ostia,
            chips: strings(&["host"]),
            same_line: false,
            separator: PromptSeparator::Greater,
        }
    );
    assert_eq!(
        parse_prompt_settings(&json!({ "style": "ostia" })).style,
        PromptStyle::Ostia
    );
    assert_eq!(
        parse_prompt_settings(&json!({ "style": "zsh", "sameLine": true, "separator": "#" })),
        PromptSettings {
            style: PromptStyle::Shell,
            chips: default_chips(),
            same_line: true,
            separator: PromptSeparator::None,
        }
    );
}

#[test]
fn never_shares_the_default_chip_list_with_the_result() {
    let mut parsed = parse_prompt_settings(&Value::Null);
    parsed.chips.push("host".to_owned());
    assert_eq!(PromptSettings::default().chips, default_chips());
}

#[test]
fn renders_none_as_nothing_and_the_rest_as_themselves() {
    assert_eq!(separator_text(PromptSeparator::None), "");
    assert_eq!(separator_text(PromptSeparator::Percent), "%");
    assert_eq!(separator_text(PromptSeparator::Dollar), "$");
    assert_eq!(separator_text(PromptSeparator::Greater), ">");
}

#[test]
fn reads_a_non_object_setting_as_the_default() {
    for raw in [json!(7), json!("shell"), json!([1]), json!(true)] {
        assert_eq!(
            parse_prompt_settings(&raw),
            PromptSettings::default(),
            "{raw}"
        );
    }
}

#[test]
fn takes_all_four_separators_and_refuses_other_text() {
    for (text, expected) in [
        ("none", PromptSeparator::None),
        ("%", PromptSeparator::Percent),
        ("$", PromptSeparator::Dollar),
        (">", PromptSeparator::Greater),
    ] {
        let parsed = parse_prompt_settings(&json!({ "separator": text }));
        assert_eq!(parsed.separator, expected, "{text}");
    }
    for bad in [json!("#"), json!(""), json!(1), json!(null)] {
        let parsed = parse_prompt_settings(&json!({ "separator": bad }));
        assert_eq!(parsed.separator, PromptSeparator::None, "{bad}");
    }
}

#[test]
fn holds_the_extension_chip_id_length_limits() {
    let long_ext = format!("{}.x", "a".repeat(40));
    let too_long_ext = format!("{}.x", "a".repeat(41));
    let long_chip = format!("ab.{}", "c".repeat(40));
    let too_long_chip = format!("ab.{}", "c".repeat(41));
    assert!(is_prompt_chip_id(&json!(long_ext)));
    assert!(!is_prompt_chip_id(&json!(too_long_ext)));
    assert!(is_prompt_chip_id(&json!(long_chip)));
    assert!(!is_prompt_chip_id(&json!(too_long_chip)));
    assert!(!is_prompt_chip_id(&json!("a.b")));
    assert!(!is_prompt_chip_id(&json!("ab.1x")));
    assert!(!is_prompt_chip_id(&json!("exitcode")));
    assert!(is_prompt_chip_id(&json!("exitCode")));
}
