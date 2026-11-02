#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::app_menu::{AppMenuEntry, electron_accelerator, parse_app_menu_spec};
use ostia_contract::chord_spec::ChordSpec;
use serde_json::{Value, json};

fn section(items: Vec<Value>) -> Value {
    json!({"label": "X", "items": items})
}

fn spec(file: Vec<Value>) -> Value {
    json!({
        "file": section(file),
        "view": section(vec![]),
        "go": section(vec![]),
        "help": section(vec![])
    })
}

fn command(command: &str, label: &str, accelerator: Option<&str>) -> AppMenuEntry {
    AppMenuEntry::Command {
        command: command.to_owned(),
        label: label.to_owned(),
        accelerator: accelerator.map(str::to_owned),
    }
}

#[test]
fn keeps_commands_labels_accelerators_and_separators() {
    let parsed = parse_app_menu_spec(&spec(vec![
        json!({"command": "workspace.new", "label": "New Workspace", "accelerator": "Cmd+T"}),
        json!({"separator": true}),
        json!({"command": "workspace.save", "label": "Save Workspace"}),
    ]))
    .unwrap();
    assert_eq!(
        parsed.file.items,
        [
            command("workspace.new", "New Workspace", Some("Cmd+T")),
            AppMenuEntry::Separator,
            command("workspace.save", "Save Workspace", None),
        ]
    );
}

#[test]
fn drops_an_accelerator_that_is_not_a_plain_key_combination() {
    let parsed = parse_app_menu_spec(&spec(vec![
        json!({"command": "a.b", "label": "A", "accelerator": "Cmd+T; x"}),
    ]))
    .unwrap();
    assert_eq!(parsed.file.items, [command("a.b", "A", None)]);
}

#[test]
fn rejects_a_spec_with_a_missing_section_a_bad_command_id_or_an_empty_label() {
    assert!(parse_app_menu_spec(&Value::Null).is_none());
    assert!(parse_app_menu_spec(&json!({"file": section(vec![])})).is_none());
    assert!(parse_app_menu_spec(&spec(vec![json!({"command": "../x", "label": "A"})])).is_none());
    assert!(parse_app_menu_spec(&spec(vec![json!({"command": "a.b", "label": " "})])).is_none());
    let too_many = (0..41).map(|_| json!({"separator": true})).collect();
    assert!(parse_app_menu_spec(&spec(too_many)).is_none());
}

fn chord(ctrl: bool, shift: bool, alt: bool, meta: bool, key: &str) -> Option<String> {
    electron_accelerator(&ChordSpec {
        ctrl,
        shift,
        alt,
        meta,
        key: key.to_owned(),
        terminal: false,
    })
}

#[test]
fn writes_chords_the_way_electron_menus_expect() {
    assert_eq!(
        chord(false, true, false, true, "x").as_deref(),
        Some("Shift+Cmd+X")
    );
    assert_eq!(
        chord(true, false, false, true, "]").as_deref(),
        Some("Ctrl+Cmd+]")
    );
    assert_eq!(
        chord(true, true, false, false, "tab").as_deref(),
        Some("Ctrl+Shift+Tab")
    );
    assert_eq!(
        chord(true, false, false, true, "left").as_deref(),
        Some("Ctrl+Cmd+Left")
    );
    assert_eq!(
        chord(false, false, false, true, "\\").as_deref(),
        Some("Cmd+\\")
    );
    assert_eq!(
        chord(false, false, false, true, "=").as_deref(),
        Some("Cmd+=")
    );
    assert_eq!(
        chord(false, false, false, true, ",").as_deref(),
        Some("Cmd+,")
    );
}

#[test]
fn names_keys_by_class_and_refuses_an_unknown_key_new_case() {
    let table = [
        ("enter", Some("Return")),
        ("escape", Some("Esc")),
        ("space", Some("Space")),
        ("+", Some("Plus")),
        ("pageup", Some("PageUp")),
        ("f1", Some("F1")),
        ("f24", Some("F24")),
        ("f25", None),
        ("f0", None),
        ("7", Some("7")),
        ("A", None),
        ("ab", None),
        ("", None),
        ("é", None),
    ];
    for (key, expected) in table {
        assert_eq!(
            chord(false, false, false, false, key).as_deref(),
            expected,
            "key {key:?}"
        );
    }
}

#[test]
fn orders_modifiers_ctrl_alt_shift_cmd_new_case() {
    assert_eq!(
        chord(true, true, true, true, "a").as_deref(),
        Some("Ctrl+Alt+Shift+Cmd+A")
    );
}

#[test]
fn checks_the_menu_limits_and_the_label_length_in_utf16_units_new_case() {
    let at_limit = (0..40).map(|_| json!({"separator": true})).collect();
    assert!(parse_app_menu_spec(&spec(at_limit)).is_some());
    let label = |text: String| {
        parse_app_menu_spec(&spec(vec![json!({"command": "a.b", "label": text})])).is_some()
    };
    assert!(label("a".repeat(120)));
    assert!(!label("a".repeat(121)));
    assert!(label("😀".repeat(60)));
    assert!(!label("😀".repeat(61)));
    assert!(!label("\u{feff}".to_owned()));
    assert!(parse_app_menu_spec(&spec(vec![json!({"command": "a.b"})])).is_none());
    assert!(parse_app_menu_spec(&spec(vec![json!(1)])).is_none());
}

#[test]
fn checks_the_command_id_and_the_accelerator_shape_new_case() {
    let id = |text: &str| {
        parse_app_menu_spec(&spec(vec![json!({"command": text, "label": "A"})])).is_some()
    };
    assert!(id("a"));
    assert!(id("A_b-c.d"));
    assert!(id(&format!("a{}", "b".repeat(127))));
    assert!(!id(&format!("a{}", "b".repeat(128))));
    assert!(!id(""));
    assert!(!id(".a"));
    assert!(!id("a b"));
    assert!(!id("é"));
    assert!(!id("a\n"));
    let accelerator = |text: &str| {
        parse_app_menu_spec(&spec(vec![
            json!({"command": "a.b", "label": "A", "accelerator": text}),
        ]))
        .unwrap()
        .file
        .items
            == [command("a.b", "A", Some(text))]
    };
    assert!(accelerator("Cmd+,"));
    assert!(accelerator("Ctrl+Shift+]"));
    assert!(accelerator(&"a".repeat(48)));
    assert!(!accelerator(&"a".repeat(49)));
    assert!(!accelerator(""));
    assert!(!accelerator("Cmd+é"));
    assert!(!accelerator("Cmd+T\n"));
}

#[test]
fn rejects_a_spec_whose_section_is_not_an_object_with_a_list_new_case() {
    let mut bad = spec(vec![]);
    bad["go"] = json!({"label": "Go", "items": "x"});
    assert!(parse_app_menu_spec(&bad).is_none());
    let mut bad = spec(vec![]);
    bad["go"] = json!(null);
    assert!(parse_app_menu_spec(&bad).is_none());
    let mut bad = spec(vec![]);
    bad["help"] = json!({"items": []});
    assert!(parse_app_menu_spec(&bad).is_none());
}
