use std::collections::BTreeMap;

use ostia_base::js::{is_js_space, js_trim, utf16_len};
use ostia_contract::chord_spec::{
    ChordProblem, ChordSpec, DIGIT_RANGE, is_double_shift, parse_chord,
};
use ostia_contract::proto_guard::is_dangerous_segment;
use serde::Serialize;
use serde_json::Value;

pub const TERMINAL_SEND_MAX: usize = 1024;

const ESC: char = '\x1b';

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalSendType {
    Text,
    Escape,
    Hex,
}

impl TerminalSendType {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "text" => Some(Self::Text),
            "escape" => Some(Self::Escape),
            "hex" => Some(Self::Hex),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TerminalSend {
    #[serde(rename = "type")]
    pub send_type: TerminalSendType,
    pub value: String,
}

pub type TerminalKeyMap = BTreeMap<String, Option<TerminalSend>>;

fn text_escape(ch: char) -> Option<char> {
    match ch {
        'n' => Some('\n'),
        'r' => Some('\r'),
        't' => Some('\t'),
        'e' => Some(ESC),
        '\\' => Some('\\'),
        _ => None,
    }
}

fn hex_escape(rest: &[char]) -> Option<char> {
    match rest {
        ['x', high, low, ..] if matches!(high, '0'..='7') && low.is_ascii_hexdigit() => {
            let code = high.to_digit(16)? * 16 + low.to_digit(16)?;
            char::from_u32(code)
        }
        _ => None,
    }
}

fn decode_text(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch != '\\' {
            out.push(ch);
            index += 1;
            continue;
        }
        let rest = &chars[index + 1..];
        if let Some(byte) = hex_escape(rest) {
            out.push(byte);
            index += 4;
            continue;
        }
        out.push(text_escape(*rest.first()?)?);
        index += 2;
    }
    if out.is_empty() { None } else { Some(out) }
}

fn hex_byte(token: &str) -> Option<char> {
    let body = token
        .strip_prefix("0x")
        .or_else(|| token.strip_prefix("0X"))
        .unwrap_or(token);
    let digits: Vec<char> = body.chars().collect();
    let valid = match digits.as_slice() {
        [low] => low.is_ascii_hexdigit(),
        [high, low] => matches!(high, '0'..='7') && low.is_ascii_hexdigit(),
        _ => false,
    };
    if !valid {
        return None;
    }
    char::from_u32(u32::from_str_radix(body, 16).ok()?)
}

fn decode_hex(value: &str) -> Option<String> {
    let tokens: Vec<&str> = value
        .split(|ch: char| is_js_space(ch) || ch == ',')
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    tokens.into_iter().map(hex_byte).collect()
}

pub fn send_data(send: &TerminalSend) -> Option<String> {
    if send.value.is_empty() || utf16_len(&send.value) > TERMINAL_SEND_MAX {
        return None;
    }
    match send.send_type {
        TerminalSendType::Escape => Some(format!("{ESC}{}", send.value)),
        TerminalSendType::Hex => decode_hex(&send.value),
        TerminalSendType::Text => decode_text(&send.value),
    }
}

pub fn same_send(a: &TerminalSend, b: &TerminalSend) -> bool {
    a.send_type == b.send_type && a.value == b.value
}

pub fn parse_terminal_send(raw: &Value) -> Option<TerminalSend> {
    let object = raw.as_object()?;
    let send_type = TerminalSendType::parse(object.get("type")?.as_str()?)?;
    let value = object.get("value")?.as_str()?.to_owned();
    let send = TerminalSend { send_type, value };
    send_data(&send).map(|_| send)
}

pub fn send_chord_problem(spec: &ChordSpec) -> Option<ChordProblem> {
    if spec.key == DIGIT_RANGE {
        return Some(ChordProblem::DigitRange);
    }
    if is_double_shift(spec) {
        return Some(ChordProblem::Invalid);
    }
    if spec.ctrl || spec.alt || spec.meta {
        return None;
    }
    if utf16_len(&spec.key) == 1 || spec.key == "space" {
        return Some(ChordProblem::Bare);
    }
    if spec.shift {
        return None;
    }
    match spec.key.as_str() {
        "escape" => Some(ChordProblem::Escape),
        "tab" => Some(ChordProblem::Tab),
        "enter" => Some(ChordProblem::Bare),
        _ => None,
    }
}

pub fn parse_terminal_keys(raw: &Value) -> TerminalKeyMap {
    let mut out = TerminalKeyMap::new();
    let Some(object) = raw.as_object() else {
        return out;
    };
    for (keys, value) in object {
        let chord = js_trim(keys);
        if chord.is_empty() || is_dangerous_segment(chord) {
            continue;
        }
        if parse_chord(chord, true).is_none() && parse_chord(chord, false).is_none() {
            continue;
        }
        if value.is_null() {
            out.insert(chord.to_owned(), None);
            continue;
        }
        if let Some(send) = parse_terminal_send(value) {
            out.insert(chord.to_owned(), Some(send));
        }
    }
    out
}
