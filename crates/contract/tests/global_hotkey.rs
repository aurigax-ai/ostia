#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::global_hotkey::{
    GLOBAL_HOTKEY_MAX_LENGTH, parse_global_hotkey, to_accelerator,
};
use serde_json::{Value, json};

fn accelerator(raw: &str) -> Option<String> {
    to_accelerator(&json!(raw))
}

#[test]
fn turns_a_chord_into_an_electron_accelerator() {
    let table = [
        ("Ctrl+Alt+Space", "Ctrl+Alt+Space"),
        ("ctrl + shift + p", "Ctrl+Shift+P"),
        ("Mod+`", "CommandOrControl+`"),
        ("Super+F12", "Super+F12"),
        ("Cmd+Option+Up", "Command+Alt+Up"),
    ];
    for (raw, expected) in table {
        assert_eq!(accelerator(raw).as_deref(), Some(expected), "{raw}");
    }
}

#[test]
fn refuses_a_bare_key_shift_alone_a_repeated_or_unknown_modifier_and_unknown_keys() {
    for bad in [
        "Space",
        "F1",
        "Shift+A",
        "Ctrl+Ctrl+A",
        "Hyper+A",
        "Ctrl+",
        "Ctrl+Foo",
        "",
    ] {
        assert_eq!(accelerator(bad), None, "{bad}");
    }
    assert_eq!(to_accelerator(&json!(7)), None);
    let too_long = format!("Ctrl+{}", "A".repeat(80));
    assert_eq!(accelerator(&too_long), None);
}

#[test]
fn keeps_a_valid_chord_as_typed_and_drops_an_invalid_one() {
    assert_eq!(
        parse_global_hotkey(&json!(" Ctrl+Alt+Space ")),
        "Ctrl+Alt+Space"
    );
    assert_eq!(parse_global_hotkey(&json!("Space")), "");
    assert_eq!(parse_global_hotkey(&Value::Null), "");
}

#[test]
fn reads_anything_that_is_not_a_string_as_no_chord() {
    for raw in [
        json!(null),
        json!(true),
        json!(7),
        json!(["Ctrl+A"]),
        json!({"key": "Ctrl+A"}),
    ] {
        assert_eq!(to_accelerator(&raw), None, "{raw}");
        assert_eq!(parse_global_hotkey(&raw), "", "{raw}");
    }
}

#[test]
fn accepts_a_chord_of_exactly_the_maximum_length_and_refuses_one_more() {
    assert_eq!(GLOBAL_HOTKEY_MAX_LENGTH, 64);
    let at_limit = format!("Ctrl{}+A", " ".repeat(GLOBAL_HOTKEY_MAX_LENGTH - 6));
    assert_eq!(at_limit.chars().count(), GLOBAL_HOTKEY_MAX_LENGTH);
    assert_eq!(accelerator(&at_limit).as_deref(), Some("Ctrl+A"));
    let over_limit = format!("Ctrl{}+A", " ".repeat(GLOBAL_HOTKEY_MAX_LENGTH - 5));
    assert_eq!(over_limit.chars().count(), GLOBAL_HOTKEY_MAX_LENGTH + 1);
    assert_eq!(accelerator(&over_limit), None);
}

#[test]
fn maps_every_modifier_name_and_ignores_its_case() {
    let table = [
        ("ctrl", "Ctrl"),
        ("CONTROL", "Ctrl"),
        ("Alt", "Alt"),
        ("OPTION", "Alt"),
        ("Shift", "Shift"),
        ("super", "Super"),
        ("META", "Super"),
        ("cmd", "Command"),
        ("Command", "Command"),
        ("mod", "CommandOrControl"),
        ("CmdOrCtrl", "CommandOrControl"),
        ("CommandOrControl", "CommandOrControl"),
    ];
    for (modifier, expected) in table {
        let raw = if modifier.eq_ignore_ascii_case("shift") {
            format!("{modifier}+Ctrl+A")
        } else {
            format!("{modifier}+A")
        };
        let want = if modifier.eq_ignore_ascii_case("shift") {
            "Shift+Ctrl+A".to_owned()
        } else {
            format!("{expected}+A")
        };
        assert_eq!(accelerator(&raw), Some(want), "{raw}");
    }
}

#[test]
fn refuses_a_repeated_modifier_also_when_two_names_mean_the_same_one() {
    for bad in [
        "Ctrl+Control+A",
        "Alt+Option+A",
        "Super+Meta+A",
        "Cmd+Command+A",
        "Mod+CmdOrCtrl+A",
    ] {
        assert_eq!(accelerator(bad), None, "{bad}");
    }
}

#[test]
fn allows_shift_with_another_modifier_and_keeps_the_modifier_order() {
    assert_eq!(accelerator("Shift+Ctrl+A").as_deref(), Some("Shift+Ctrl+A"));
    assert_eq!(
        accelerator("Alt+Shift+Left").as_deref(),
        Some("Alt+Shift+Left")
    );
}

#[test]
fn refuses_an_empty_part_between_or_after_the_modifiers() {
    for bad in ["Ctrl++A", "+Ctrl+A", "Ctrl+ +A", "Ctrl++", "+A", "+"] {
        assert_eq!(accelerator(bad), None, "{bad}");
    }
}

#[test]
fn names_the_named_keys_and_ignores_their_case() {
    let table = [
        ("space", "Space"),
        ("UP", "Up"),
        ("Down", "Down"),
        ("left", "Left"),
        ("RIGHT", "Right"),
        ("home", "Home"),
        ("end", "End"),
        ("pageup", "PageUp"),
        ("PAGEDOWN", "PageDown"),
        ("insert", "Insert"),
        ("delete", "Delete"),
        ("backspace", "Backspace"),
        ("ENTER", "Enter"),
    ];
    for (key, expected) in table {
        assert_eq!(
            accelerator(&format!("Ctrl+{key}")),
            Some(format!("Ctrl+{expected}")),
            "{key}"
        );
    }
    assert_eq!(accelerator("Ctrl+Tab"), None);
    assert_eq!(accelerator("Ctrl+Page Up"), None);
}

#[test]
fn upper_cases_a_letter_or_digit_key_and_refuses_a_longer_name() {
    assert_eq!(accelerator("Ctrl+a").as_deref(), Some("Ctrl+A"));
    assert_eq!(accelerator("Ctrl+z").as_deref(), Some("Ctrl+Z"));
    assert_eq!(accelerator("Ctrl+0").as_deref(), Some("Ctrl+0"));
    assert_eq!(accelerator("Ctrl+9").as_deref(), Some("Ctrl+9"));
    assert_eq!(accelerator("Ctrl+AB"), None);
    assert_eq!(accelerator("Ctrl+10"), None);
    assert_eq!(accelerator("Ctrl+\u{e9}"), None);
}

#[test]
fn accepts_function_keys_one_to_twenty_four_and_refuses_the_rest() {
    for n in 1..=24 {
        assert_eq!(
            accelerator(&format!("Ctrl+f{n}")),
            Some(format!("Ctrl+F{n}")),
            "F{n}"
        );
    }
    for bad in ["Ctrl+F0", "Ctrl+F25", "Ctrl+F99", "Ctrl+F01", "Ctrl+F"] {
        assert_eq!(accelerator(bad), None, "{bad}");
    }
}

#[test]
fn keeps_a_punctuation_key_as_typed_and_refuses_other_symbols() {
    for key in [",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"] {
        assert_eq!(
            accelerator(&format!("Alt+{key}")),
            Some(format!("Alt+{key}")),
            "{key}"
        );
    }
    for bad in ["!", "@", "#", "(", "~", "_", "<", "\u{a7}"] {
        assert_eq!(accelerator(&format!("Alt+{bad}")), None, "{bad}");
    }
}

#[test]
fn trims_the_space_around_each_part_but_not_inside_one() {
    assert_eq!(
        accelerator("  ctrl  +  alt  +  x  ").as_deref(),
        Some("Ctrl+Alt+X")
    );
    assert_eq!(accelerator("Ctrl+ Space").as_deref(), Some("Ctrl+Space"));
    assert_eq!(accelerator("Ct rl+A"), None);
}

#[test]
fn keeps_the_surrounding_space_off_a_valid_chord_but_not_the_inner_space() {
    assert_eq!(
        parse_global_hotkey(&json!("\t ctrl + shift + p \n")),
        "ctrl + shift + p"
    );
}
