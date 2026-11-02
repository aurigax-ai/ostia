#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_browser::guest_key::GuestKeyInput;
use ostia_browser::guest_key_event::{KeyboardInputEvent, guest_key_events, guest_key_name};
use ostia_contract::modifier_remap::ModifierFlags;

#[test]
fn names_the_physical_key_from_its_code_whatever_the_layout_typed() {
    assert_eq!(guest_key_name("KeyQ", "q", false).as_deref(), Some("Q"));
    assert_eq!(guest_key_name("Digit7", "7", false).as_deref(), Some("7"));
    assert_eq!(guest_key_name("F12", "F12", false).as_deref(), Some("F12"));
    assert_eq!(
        guest_key_name("ArrowLeft", "ArrowLeft", false).as_deref(),
        Some("Left")
    );
    assert_eq!(
        guest_key_name("BracketLeft", "[", false).as_deref(),
        Some("[")
    );
    assert_eq!(
        guest_key_name("ShiftRight", "Shift", false).as_deref(),
        Some("Shift")
    );
}

#[test]
fn follows_the_typed_letter_unless_option_has_composed_it() {
    assert_eq!(guest_key_name("KeyC", "j", false).as_deref(), Some("J"));
    assert_eq!(guest_key_name("KeyC", "ç", true).as_deref(), Some("C"));
    assert_eq!(guest_key_name("KeyQ", "é", false).as_deref(), Some("Q"));
}

#[test]
fn follows_the_typed_character_on_punctuation_and_digit_positions_too() {
    assert_eq!(
        guest_key_name("Semicolon", "s", false).as_deref(),
        Some("S")
    );
    assert_eq!(guest_key_name("KeyQ", "'", false).as_deref(), Some("'"));
    assert_eq!(guest_key_name("Digit1", "&", false).as_deref(), Some("&"));
    assert_eq!(guest_key_name("Slash", "z", false).as_deref(), Some("Z"));
    assert_eq!(
        guest_key_name("Semicolon", "ß", false).as_deref(),
        Some(";")
    );
    assert_eq!(guest_key_name("Semicolon", "ß", true).as_deref(), Some(";"));
}

#[test]
fn has_no_name_for_a_key_it_cannot_send() {
    assert_eq!(guest_key_name("Numpad1", "1", false), None);
    assert_eq!(guest_key_name("constructor", "x", false), None);
    assert_eq!(guest_key_name("", "", false), None);
}

#[test]
fn names_every_named_key_and_every_character_key() {
    let named = [
        ("ShiftLeft", "Shift"),
        ("ShiftRight", "Shift"),
        ("Space", "Space"),
        ("Enter", "Enter"),
        ("Tab", "Tab"),
        ("Backspace", "Backspace"),
        ("Delete", "Delete"),
        ("Escape", "Escape"),
        ("Insert", "Insert"),
        ("Home", "Home"),
        ("End", "End"),
        ("PageUp", "PageUp"),
        ("PageDown", "PageDown"),
        ("ArrowLeft", "Left"),
        ("ArrowRight", "Right"),
        ("ArrowUp", "Up"),
        ("ArrowDown", "Down"),
        ("Minus", "-"),
        ("Equal", "="),
        ("BracketLeft", "["),
        ("BracketRight", "]"),
        ("Backslash", "\\"),
        ("Semicolon", ";"),
        ("Quote", "'"),
        ("Backquote", "`"),
        ("Comma", ","),
        ("Period", "."),
        ("Slash", "/"),
    ];
    for (code, name) in named {
        assert_eq!(
            guest_key_name(code, "", false).as_deref(),
            Some(name),
            "{code}"
        );
    }
}

#[test]
fn names_function_keys_one_to_twenty_four_and_no_others() {
    for n in 1..=24 {
        let code = format!("F{n}");
        assert_eq!(
            guest_key_name(&code, "", false).as_deref(),
            Some(code.as_str()),
            "{code}"
        );
    }
    for code in ["F0", "F25", "F01", "F100", "f1"] {
        assert_eq!(guest_key_name(code, "", false), None, "{code}");
    }
}

#[test]
fn takes_letter_and_digit_codes_only_in_the_exact_shape() {
    for code in ["Keya", "KeyAB", "Key", "Digit", "Digit12", "DigitA", "KeyÀ"] {
        assert_eq!(guest_key_name(code, "x", false), None, "{code}");
    }
}

#[test]
fn uppercases_a_typed_printable_ascii_key_and_ignores_other_typed_text() {
    assert_eq!(guest_key_name("KeyC", "~", false).as_deref(), Some("~"));
    assert_eq!(guest_key_name("KeyC", "!", false).as_deref(), Some("!"));
    assert_eq!(guest_key_name("KeyC", " ", false).as_deref(), Some("C"));
    assert_eq!(guest_key_name("KeyC", "ab", false).as_deref(), Some("C"));
    assert_eq!(guest_key_name("KeyC", "", false).as_deref(), Some("C"));
    assert_eq!(guest_key_name("KeyC", "j", true).as_deref(), Some("C"));
}

fn input(key: &str, code: &str, kind: &str) -> GuestKeyInput {
    GuestKeyInput {
        kind: kind.to_owned(),
        key: key.to_owned(),
        code: code.to_owned(),
        ..GuestKeyInput::default()
    }
}

fn y() -> GuestKeyInput {
    input("y", "KeyY", "keyDown")
}

const ALT: ModifierFlags = ModifierFlags {
    ctrl: false,
    alt: true,
    meta: false,
};

fn event(kind: &str, key_code: &str, modifiers: &[&str]) -> KeyboardInputEvent {
    KeyboardInputEvent {
        kind: kind.to_owned(),
        key_code: key_code.to_owned(),
        modifiers: modifiers.iter().map(|m| (*m).to_owned()).collect(),
    }
}

#[test]
fn types_the_character_with_the_key_unless_control_or_command_is_held() {
    assert_eq!(guest_key_events(&y(), "Y", ALT).len(), 2);
    let meta = ModifierFlags { meta: true, ..ALT };
    assert_eq!(guest_key_events(&y(), "Y", meta).len(), 1);
    let up = input("y", "KeyY", "keyUp");
    assert_eq!(guest_key_events(&up, "Y", ALT).len(), 1);
}

#[test]
fn sends_a_carriage_return_for_enter_so_a_field_gets_its_newline() {
    let enter = input("Enter", "Enter", "keyDown");
    assert_eq!(
        guest_key_events(&enter, "Enter", ALT)[1],
        event("char", "\r", &["alt"])
    );
    let tab = input("Tab", "Tab", "keyDown");
    assert_eq!(guest_key_events(&tab, "Tab", ALT).len(), 1);
}

#[test]
fn sends_the_key_event_first_with_the_key_code_it_was_given() {
    let events = guest_key_events(&y(), "Y", ALT);
    assert_eq!(events[0], event("keyDown", "Y", &["alt"]));
    assert_eq!(events[1], event("char", "y", &["alt"]));
    let up = input("y", "KeyY", "keyUp");
    assert_eq!(guest_key_events(&up, "Y", ALT)[0].kind, "keyUp");
}

#[test]
fn sends_a_key_up_for_any_type_that_is_not_key_down() {
    let other = input("y", "KeyY", "rawKeyDown");
    let events = guest_key_events(&other, "Y", ALT);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "keyUp");
}

#[test]
fn lists_modifiers_in_the_order_shift_control_alt_meta_auto_repeat() {
    let all = GuestKeyInput {
        shift: true,
        is_auto_repeat: true,
        ..y()
    };
    let flags = ModifierFlags {
        ctrl: true,
        alt: true,
        meta: true,
    };
    assert_eq!(
        guest_key_events(&all, "Y", flags)[0].modifiers,
        ["shift", "control", "alt", "meta", "isautorepeat"]
    );
    let none = ModifierFlags {
        ctrl: false,
        alt: false,
        meta: false,
    };
    assert!(guest_key_events(&y(), "Y", none)[0].modifiers.is_empty());
}

#[test]
fn takes_control_alt_and_meta_from_the_flags_and_not_from_the_input() {
    let pressed = GuestKeyInput {
        control: true,
        alt: true,
        meta: true,
        ..y()
    };
    let none = ModifierFlags {
        ctrl: false,
        alt: false,
        meta: false,
    };
    let events = guest_key_events(&pressed, "Y", none);
    assert_eq!(events.len(), 2);
    assert!(events[0].modifiers.is_empty());
}

#[test]
fn types_no_character_when_control_is_held() {
    let ctrl = ModifierFlags {
        ctrl: true,
        alt: false,
        meta: false,
    };
    assert_eq!(guest_key_events(&y(), "Y", ctrl).len(), 1);
}

#[test]
fn types_a_character_only_for_a_single_unit_key() {
    let none = ModifierFlags {
        ctrl: false,
        alt: false,
        meta: false,
    };
    for key in ["Shift", "ArrowLeft", "Dead", "", "ab"] {
        let events = guest_key_events(&input(key, "KeyY", "keyDown"), "Y", none);
        assert_eq!(events.len(), 1, "{key:?}");
    }
    for key in ["é", "1", " ", "+"] {
        let events = guest_key_events(&input(key, "KeyY", "keyDown"), "Y", none);
        assert_eq!(events.len(), 2, "{key:?}");
        assert_eq!(events[1].key_code, key, "{key:?}");
    }
}
