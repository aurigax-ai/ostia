use ostia_base::js::js_trim;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChordSpec {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyLike {
    pub key: String,
    pub code: String,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    pub alt: bool,
}

const MODIFIER_KEYS: [&str; 8] = [
    "Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "Hyper", "Super",
];

pub fn parse_chord(text: &str, mac: bool) -> Option<ChordSpec> {
    let mut parts: Vec<&str> = text.split('+').map(js_trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let raw_key = parts.pop()?;
    let mut spec = ChordSpec {
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
        key: String::new(),
    };
    for part in parts {
        set_modifier(&mut spec, part, mac)?;
    }
    spec.key = normalize_key(raw_key)?;
    if spec.key == "shift" && !is_double_shift(&spec) {
        return None;
    }
    Some(spec)
}

fn set_modifier(spec: &mut ChordSpec, name: &str, mac: bool) -> Option<()> {
    let flag = match name.to_lowercase().as_str() {
        "ctrl" | "control" => &mut spec.ctrl,
        "shift" => &mut spec.shift,
        "alt" | "option" | "opt" => &mut spec.alt,
        "cmd" | "command" | "meta" | "super" => &mut spec.meta,
        "mod" => {
            if mac {
                &mut spec.meta
            } else {
                &mut spec.ctrl
            }
        }
        _ => return None,
    };
    if *flag {
        return None;
    }
    *flag = true;
    Some(())
}

fn normalize_key(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    if let Some(named) = named_key(&lower) {
        return Some(named.to_owned());
    }
    if is_single_ascii_alphanumeric(&lower) {
        return Some(lower);
    }
    if lower.strip_prefix('f').is_some_and(is_function_number) {
        return Some(lower);
    }
    if is_punctuation(raw) {
        return Some(raw.to_owned());
    }
    None
}

fn named_key(lower: &str) -> Option<&'static str> {
    Some(match lower {
        "up" | "arrowup" | "↑" => "up",
        "down" | "arrowdown" | "↓" => "down",
        "left" | "arrowleft" | "←" => "left",
        "right" | "arrowright" | "→" => "right",
        "space" | " " => "space",
        "enter" | "return" => "enter",
        "tab" => "tab",
        "escape" | "esc" => "escape",
        "backspace" => "backspace",
        "delete" | "del" => "delete",
        "home" => "home",
        "end" => "end",
        "pageup" => "pageup",
        "pagedown" => "pagedown",
        "insert" => "insert",
        "shift" => "shift",
        "1-9" => "1-9",
        _ => return None,
    })
}

fn is_single_ascii_alphanumeric(text: &str) -> bool {
    let mut chars = text.chars();
    matches!((chars.next(), chars.next()), (Some(ch), None) if ch.is_ascii_alphanumeric())
}

fn is_function_number(digits: &str) -> bool {
    matches!(
        digits.as_bytes(),
        [b'1'..=b'9'] | [b'1', b'0'..=b'9'] | [b'2', b'0'..=b'4']
    )
}

fn is_punctuation(raw: &str) -> bool {
    matches!(
        raw,
        "," | "." | "/" | ";" | "'" | "[" | "]" | "\\" | "-" | "=" | "`"
    )
}

pub fn is_double_shift(spec: &ChordSpec) -> bool {
    spec.key == "shift" && spec.shift && !spec.ctrl && !spec.alt && !spec.meta
}

pub fn spec_from_event(event: &KeyLike) -> Option<ChordSpec> {
    if MODIFIER_KEYS.contains(&event.key.as_str()) {
        return None;
    }
    Some(ChordSpec {
        ctrl: event.ctrl,
        shift: event.shift,
        alt: event.alt,
        meta: event.meta,
        key: event_key(event)?,
    })
}

fn event_key(event: &KeyLike) -> Option<String> {
    let lower = event.key.to_lowercase();
    if matches!(lower.as_bytes(), [b'a'..=b'z']) {
        return Some(lower);
    }
    if let Some(letter) = event
        .code
        .strip_prefix("Key")
        .filter(|rest| matches!(rest.as_bytes(), [b'A'..=b'Z']))
    {
        return Some(letter.to_lowercase());
    }
    if let Some(digit) = event
        .code
        .strip_prefix("Digit")
        .or_else(|| event.code.strip_prefix("Numpad"))
        .filter(|rest| matches!(rest.as_bytes(), [b'0'..=b'9']))
    {
        return Some(digit.to_owned());
    }
    if let Some(number) = event
        .code
        .strip_prefix('F')
        .filter(|rest| is_function_number(rest))
    {
        return Some(format!("f{number}"));
    }
    if let Some(key) = code_key(&event.code) {
        return Some(key.to_owned());
    }
    normalize_key(&event.key)
}

fn code_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "Semicolon" => ";",
        "Quote" => "'",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Backslash" => "\\",
        "Minus" => "-",
        "Equal" => "=",
        "Backquote" => "`",
        "Space" => "space",
        "Enter" | "NumpadEnter" => "enter",
        "Tab" => "tab",
        "Escape" => "escape",
        "Backspace" => "backspace",
        "Delete" => "delete",
        "Home" => "home",
        "End" => "end",
        "PageUp" => "pageup",
        "PageDown" => "pagedown",
        "Insert" => "insert",
        "ArrowUp" => "up",
        "ArrowDown" => "down",
        "ArrowLeft" => "left",
        "ArrowRight" => "right",
        _ => return None,
    })
}
