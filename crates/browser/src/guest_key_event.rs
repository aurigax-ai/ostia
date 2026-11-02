use ostia_contract::modifier_remap::ModifierFlags;

use crate::guest_key::GuestKeyInput;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyboardInputEvent {
    pub kind: String,
    pub key_code: String,
    pub modifiers: Vec<String>,
}

const NAMED_KEYS: [(&str, &str); 17] = [
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
];

const CHARACTER_KEYS: [(&str, &str); 11] = [
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

fn lookup(table: &[(&str, &'static str)], code: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(name, _)| *name == code)
        .map(|(_, value)| *value)
}

fn single_suffix<'a>(code: &'a str, prefix: &str, accepts: fn(char) -> bool) -> Option<&'a str> {
    let rest = code.strip_prefix(prefix)?;
    let mut chars = rest.chars();
    let first = chars.next()?;
    (chars.next().is_none() && accepts(first)).then_some(rest)
}

fn is_function_key(code: &str) -> bool {
    let Some(digits) = code.strip_prefix('F') else {
        return false;
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || digits.starts_with('0') {
        return false;
    }
    digits.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n))
}

fn is_printable_ascii(key: &str) -> bool {
    let mut chars = key.chars();
    matches!((chars.next(), chars.next()), (Some('\x21'..='\x7e'), None))
}

pub fn guest_key_name(code: &str, key: &str, alt: bool) -> Option<String> {
    let character = single_suffix(code, "Key", |c| c.is_ascii_uppercase())
        .or_else(|| single_suffix(code, "Digit", |c| c.is_ascii_digit()))
        .or_else(|| lookup(&CHARACTER_KEYS, code));
    if let Some(character) = character {
        return Some(if !alt && is_printable_ascii(key) {
            key.to_ascii_uppercase()
        } else {
            character.to_owned()
        });
    }
    if is_function_key(code) {
        return Some(code.to_owned());
    }
    lookup(&NAMED_KEYS, code).map(str::to_owned)
}

fn typed_text(key: &str) -> Option<String> {
    if key == "Enter" {
        return Some("\r".to_owned());
    }
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.len_utf16() == 1 => Some(c.to_string()),
        _ => None,
    }
}

pub fn guest_key_events(
    input: &GuestKeyInput,
    key_code: &str,
    flags: ModifierFlags,
) -> Vec<KeyboardInputEvent> {
    let mut modifiers = Vec::new();
    for (held, name) in [
        (input.shift, "shift"),
        (flags.ctrl, "control"),
        (flags.alt, "alt"),
        (flags.meta, "meta"),
        (input.is_auto_repeat, "isautorepeat"),
    ] {
        if held {
            modifiers.push(name.to_owned());
        }
    }
    let down = input.kind == "keyDown";
    let mut events = vec![KeyboardInputEvent {
        kind: if down { "keyDown" } else { "keyUp" }.to_owned(),
        key_code: key_code.to_owned(),
        modifiers: modifiers.clone(),
    }];
    if down
        && !flags.ctrl
        && !flags.meta
        && let Some(text) = typed_text(&input.key)
    {
        events.push(KeyboardInputEvent {
            kind: "char".to_owned(),
            key_code: text,
            modifiers,
        });
    }
    events
}
