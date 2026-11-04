use ostia_base::js::js_trim;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyModifier {
    Shift,
    Control,
    Alt,
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCombo {
    pub key_code: String,
    pub modifiers: Vec<KeyModifier>,
    pub printable: bool,
}

fn modifier_named(name: &str) -> Option<KeyModifier> {
    match name {
        "shift" => Some(KeyModifier::Shift),
        "control" | "ctrl" => Some(KeyModifier::Control),
        "alt" | "option" => Some(KeyModifier::Alt),
        "meta" | "cmd" | "command" | "super" => Some(KeyModifier::Meta),
        _ => None,
    }
}

fn key_alias(name: &str) -> Option<&'static str> {
    match name {
        "enter" | "return" => Some("Return"),
        "esc" | "escape" => Some("Escape"),
        "arrowup" | "up" => Some("Up"),
        "arrowdown" | "down" => Some("Down"),
        "arrowleft" | "left" => Some("Left"),
        "arrowright" | "right" => Some("Right"),
        "space" | " " => Some("Space"),
        "tab" => Some("Tab"),
        "backspace" => Some("Backspace"),
        "delete" => Some("Delete"),
        "home" => Some("Home"),
        "end" => Some("End"),
        "pageup" => Some("PageUp"),
        "pagedown" => Some("PageDown"),
        _ => None,
    }
}

pub fn parse_key_combo(combo: &str) -> Option<KeyCombo> {
    if combo.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> = if combo == "+" {
        vec!["+"]
    } else if let Some(head) = combo.strip_suffix("++") {
        let mut parts: Vec<&str> = head.split('+').collect();
        parts.push("+");
        parts
    } else {
        combo.split('+').collect()
    };
    let raw_key = parts.pop().unwrap_or("");
    let mut modifiers = Vec::new();
    for part in parts {
        let modifier = modifier_named(&part.to_lowercase())?;
        if !modifiers.contains(&modifier) {
            modifiers.push(modifier);
        }
    }
    if raw_key.is_empty() {
        return None;
    }
    let key_code = key_alias(&raw_key.to_lowercase()).unwrap_or(raw_key);
    let printable = key_code.chars().count() == 1
        && !modifiers.contains(&KeyModifier::Control)
        && !modifiers.contains(&KeyModifier::Meta);
    Some(KeyCombo {
        key_code: key_code.to_owned(),
        modifiers,
        printable,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobToken {
    Unit(u16),
    One,
    Run,
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn glob_tokens(pattern: &str) -> Vec<GlobToken> {
    let mut tokens: Vec<GlobToken> = Vec::new();
    for ch in pattern.chars() {
        match ch {
            '*' => {
                if tokens.last() != Some(&GlobToken::Run) {
                    tokens.push(GlobToken::Run);
                }
            }
            '?' => tokens.push(GlobToken::One),
            other => {
                let mut buffer = [0u16; 2];
                tokens.extend(
                    other
                        .encode_utf16(&mut buffer)
                        .iter()
                        .map(|unit| GlobToken::Unit(*unit)),
                );
            }
        }
    }
    tokens
}

pub fn glob_matches(pattern: &str, url: &str) -> bool {
    let tokens = glob_tokens(pattern);
    let units: Vec<u16> = url.encode_utf16().collect();
    let mut token = 0;
    let mut unit = 0;
    let mut resume: Option<(usize, usize)> = None;
    while unit < units.len() {
        let step = match tokens.get(token) {
            Some(GlobToken::Unit(expected)) => units[unit] == *expected,
            Some(GlobToken::One) => !is_line_terminator(units[unit]),
            Some(GlobToken::Run) => {
                resume = Some((token, unit));
                token += 1;
                continue;
            }
            None => false,
        };
        if step {
            token += 1;
            unit += 1;
            continue;
        }
        let Some((run_token, run_unit)) = resume else {
            return false;
        };
        if is_line_terminator(units[run_unit]) {
            return false;
        }
        token = run_token + 1;
        unit = run_unit + 1;
        resume = Some((run_token, unit));
    }
    tokens[token..].iter().all(|rest| *rest == GlobToken::Run)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

pub const DEFAULT_SCROLL_PX: f64 = 300.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrollDelta {
    pub dx: f64,
    pub dy: f64,
}

pub fn scroll_delta(direction: ScrollDirection, px: f64) -> ScrollDelta {
    match direction {
        ScrollDirection::Up => ScrollDelta { dx: 0.0, dy: -px },
        ScrollDirection::Down => ScrollDelta { dx: 0.0, dy: px },
        ScrollDirection::Left => ScrollDelta { dx: -px, dy: 0.0 },
        ScrollDirection::Right => ScrollDelta { dx: px, dy: 0.0 },
    }
}

pub fn is_scroll_direction(value: &Value) -> bool {
    matches!(value.as_str(), Some("up" | "down" | "left" | "right"))
}

fn digits(text: &str) -> Option<i64> {
    if text.bytes().all(|byte| byte.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

pub fn status_matches(filter: &str, status: Option<i64>) -> bool {
    let Some(status) = status else {
        return false;
    };
    let bytes = filter.as_bytes();
    let range = if bytes.len() == 7 && bytes[3] == b'-' {
        digits(&filter[..3]).zip(digits(&filter[4..]))
    } else {
        None
    };
    if let Some((low, high)) = range {
        return (low..=high).contains(&status);
    }
    if bytes.len() == 3
        && bytes[1..].eq_ignore_ascii_case(b"xx")
        && (b'1'..=b'5').contains(&bytes[0])
    {
        return status.div_euclid(100) == i64::from(bytes[0] - b'0');
    }
    status.to_string() == filter
}

fn starts_with_scheme(text: &str) -> bool {
    let mut chars = text.char_indices();
    match chars.next() {
        Some((_, first)) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for (index, ch) in chars {
        if ch == ':' {
            return text[index + 1..].starts_with("//");
        }
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

fn starts_with_opaque_scheme(text: &str) -> bool {
    ["about:", "data:", "blob:", "mailto:", "javascript:"]
        .iter()
        .any(|scheme| {
            text.len() >= scheme.len()
                && text.as_bytes()[..scheme.len()].eq_ignore_ascii_case(scheme.as_bytes())
        })
}

fn loopback_host_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let lower = |prefix: &str| {
        bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
    };
    if lower("localhost") {
        return Some(9);
    }
    if lower("[::1]") {
        return Some(5);
    }
    if !text.starts_with("127.") {
        return None;
    }
    let mut end = 4;
    for group in 0..3 {
        let start = end;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == start {
            return None;
        }
        if group < 2 {
            if bytes.get(end) != Some(&b'.') {
                return None;
            }
            end += 1;
        }
    }
    Some(end)
}

fn is_loopback_url(text: &str) -> bool {
    let Some(host_len) = loopback_host_len(text) else {
        return false;
    };
    let rest = &text.as_bytes()[host_len..];
    let after_port = match rest.first() {
        Some(b':') => {
            let digit_count = rest[1..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if digit_count > 0 {
                &rest[1 + digit_count..]
            } else {
                rest
            }
        }
        _ => rest,
    };
    after_port.is_empty() || after_port[0] == b'/'
}

pub fn normalize_url(raw: &str) -> String {
    let url = js_trim(raw);
    if starts_with_scheme(url) || starts_with_opaque_scheme(url) {
        return url.to_owned();
    }
    let scheme = if is_loopback_url(url) {
        "http"
    } else {
        "https"
    };
    format!("{scheme}://{url}")
}
