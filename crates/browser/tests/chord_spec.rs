#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_browser::chord_spec::{
    ChordSpec, KeyLike, is_double_shift, parse_chord, spec_from_event,
};

fn chord(text: &str, mac: bool) -> ChordSpec {
    parse_chord(text, mac).unwrap_or_else(|| panic!("unparseable: {text}"))
}

fn spec(ctrl: bool, shift: bool, alt: bool, meta: bool, key: &str) -> ChordSpec {
    ChordSpec {
        ctrl,
        shift,
        alt,
        meta,
        key: key.to_owned(),
    }
}

fn event(key: &str, code: &str, ctrl: bool, shift: bool, meta: bool) -> KeyLike {
    KeyLike {
        key: key.to_owned(),
        code: code.to_owned(),
        ctrl,
        meta,
        shift,
        alt: false,
    }
}

#[test]
fn normalizes_case_spacing_modifier_order_and_aliases_to_one_spec() {
    assert_eq!(
        chord(" shift + ctrl + k ", false),
        spec(true, true, false, false, "k")
    );
    assert_eq!(
        chord("Control+Option+p", false),
        spec(true, false, true, false, "p")
    );
    assert_eq!(
        chord("cmd+alt+p", true),
        spec(false, false, true, true, "p")
    );
    assert_eq!(
        chord("Ctrl+Shift+ArrowUp", false),
        spec(true, true, false, false, "up")
    );
    assert_eq!(
        chord("ctrl+shift+↓", false),
        spec(true, true, false, false, "down")
    );
    assert_eq!(
        chord("Ctrl+f5", false),
        spec(true, false, false, false, "f5")
    );
    assert_eq!(
        chord("Ctrl+Esc", false),
        spec(true, false, false, false, "escape")
    );
}

#[test]
fn reads_mod_as_cmd_on_macos_and_ctrl_elsewhere() {
    assert_eq!(
        chord("Mod+Shift+K", true),
        spec(false, true, false, true, "k")
    );
    assert_eq!(
        chord("Mod+Shift+K", false),
        spec(true, true, false, false, "k")
    );
}

#[test]
fn reads_super_and_meta_and_cmd_as_the_same_key() {
    assert_eq!(chord("Super+K", false), chord("Cmd+K", false));
    assert_eq!(chord("Super+K", true), chord("Cmd+K", true));
    assert_eq!(chord("Meta+K", false), chord("Cmd+K", false));
}

#[test]
fn rejects_unknown_modifiers_unknown_keys_repeats_and_empty_parts() {
    for bad in [
        "",
        "Ctrl+",
        "+K",
        "Hyper+K",
        "Ctrl+Ctrl+K",
        "Ctrl+Shift",
        "Ctrl+Foo",
        "Ctrl++",
    ] {
        assert_eq!(parse_chord(bad, false), None, "{bad:?}");
    }
}

#[test]
fn accepts_the_digit_range_only_as_a_key_of_its_own() {
    assert_eq!(chord("Ctrl+1-9", false).key, "1-9");
    assert_eq!(parse_chord("Ctrl+1-8", false), None);
}

#[test]
fn ignores_a_modifier_pressed_alone() {
    assert_eq!(
        spec_from_event(&event("Control", "", true, false, false)),
        None
    );
    assert_eq!(
        spec_from_event(&event("Shift", "", false, true, false)),
        None
    );
}

#[test]
fn reads_shifted_digits_and_punctuation_from_the_physical_key() {
    let digit = spec_from_event(&event("!", "Digit1", true, true, false));
    assert_eq!(digit.map(|s| s.key), Some("1".to_owned()));
    let comma = spec_from_event(&event("<", "Comma", true, true, false));
    assert_eq!(comma.map(|s| s.key), Some(",".to_owned()));
}

#[test]
fn keeps_the_layout_letter_when_the_key_is_a_letter() {
    let letter = spec_from_event(&event("Z", "KeyY", true, true, false));
    assert_eq!(letter.map(|s| s.key), Some("z".to_owned()));
}

#[test]
fn falls_back_to_the_key_name_without_a_code() {
    assert_eq!(
        spec_from_event(&event("ArrowUp", "", false, false, true)),
        Some(chord("Cmd+Up", false))
    );
}

#[test]
fn parses_shift_shift_as_its_own_chord_and_never_reads_it_from_a_key() {
    let double = chord("Shift+Shift", false);
    assert!(is_double_shift(&double));
    assert_eq!(
        spec_from_event(&event("Shift", "ShiftLeft", false, true, false)),
        None
    );
}

#[test]
fn refuses_shift_on_its_own_or_with_another_modifier() {
    assert_eq!(parse_chord("Shift", false), None);
    assert_eq!(parse_chord("Ctrl+Shift", false), None);
    assert_eq!(parse_chord("Cmd+Shift", true), None);
    assert_eq!(parse_chord("Shift+Shift+Shift", false), None);
}
