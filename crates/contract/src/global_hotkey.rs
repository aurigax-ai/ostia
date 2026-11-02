use ostia_base::js::{js_trim, utf16_len};
use serde_json::Value;

pub const GLOBAL_HOTKEY_MAX_LENGTH: usize = 64;

const PUNCTUATION: [&str; 11] = [",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"];

fn modifier_name(part: &str) -> Option<&'static str> {
    Some(match part.to_lowercase().as_str() {
        "ctrl" | "control" => "Ctrl",
        "alt" | "option" => "Alt",
        "shift" => "Shift",
        "super" | "meta" => "Super",
        "cmd" | "command" => "Command",
        "mod" | "cmdorctrl" | "commandorcontrol" => "CommandOrControl",
        _ => return None,
    })
}

fn named_key(lower: &str) -> Option<&'static str> {
    Some(match lower {
        "space" => "Space",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "insert" => "Insert",
        "delete" => "Delete",
        "backspace" => "Backspace",
        "enter" => "Enter",
        _ => return None,
    })
}

fn is_single_ascii_alnum(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some(ch), None) if ch.is_ascii_lowercase() || ch.is_ascii_digit()
    )
}

fn is_function_key(lower: &str) -> bool {
    (1..=24).any(|n| lower == format!("f{n}"))
}

fn accelerator_key(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    if let Some(name) = named_key(&lower) {
        return Some(name.to_owned());
    }
    if is_single_ascii_alnum(&lower) || is_function_key(&lower) {
        return Some(lower.to_uppercase());
    }
    if PUNCTUATION.contains(&raw) {
        return Some(raw.to_owned());
    }
    None
}

pub fn to_accelerator(raw: &Value) -> Option<String> {
    let text = raw.as_str()?;
    if utf16_len(text) > GLOBAL_HOTKEY_MAX_LENGTH {
        return None;
    }
    let mut parts: Vec<&str> = text.split('+').map(js_trim).collect();
    let key_part = parts.pop()?;
    if key_part.is_empty() || parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let key = accelerator_key(key_part)?;
    let mut mods: Vec<&str> = Vec::with_capacity(parts.len() + 1);
    for part in parts {
        let modifier = modifier_name(part)?;
        if mods.contains(&modifier) {
            return None;
        }
        mods.push(modifier);
    }
    if mods == ["Shift"] {
        return None;
    }
    mods.push(&key);
    Some(mods.join("+"))
}

pub fn parse_global_hotkey(raw: &Value) -> String {
    match raw.as_str() {
        Some(text) if to_accelerator(raw).is_some() => js_trim(text).to_owned(),
        _ => String::new(),
    }
}
