use std::sync::LazyLock;

use ostia_base::js::{is_js_space, static_regex, utf16_len};
use regex::Regex;

use super::utf16_text::{from_units, line_end, line_start, slice, unit_char, units};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEditOp {
    Home,
    End,
    CharBack,
    CharForward,
    WordBack,
    WordForward,
    KillEnd,
    KillStart,
    KillWordBack,
    KillWordForward,
    DeleteChar,
    Backspace,
    Yank,
    HistoryPrev,
    HistoryNext,
    ClearScreen,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyLike {
    pub key: String,
    pub code: Option<String>,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub meta_key: bool,
    pub shift_key: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineBuffer {
    pub text: String,
    pub caret: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineEditResult {
    pub text: String,
    pub caret: usize,
    pub killed: Option<String>,
}

static WORD_CHAR: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[\p{L}\p{N}_]$"));

fn ctrl_op(letter: &str) -> Option<LineEditOp> {
    match letter {
        "a" => Some(LineEditOp::Home),
        "e" => Some(LineEditOp::End),
        "b" => Some(LineEditOp::CharBack),
        "f" => Some(LineEditOp::CharForward),
        "k" => Some(LineEditOp::KillEnd),
        "u" => Some(LineEditOp::KillStart),
        "w" => Some(LineEditOp::KillWordBack),
        "d" => Some(LineEditOp::DeleteChar),
        "h" => Some(LineEditOp::Backspace),
        "y" => Some(LineEditOp::Yank),
        "p" => Some(LineEditOp::HistoryPrev),
        "n" => Some(LineEditOp::HistoryNext),
        "l" => Some(LineEditOp::ClearScreen),
        _ => None,
    }
}

fn alt_op(letter: &str) -> Option<LineEditOp> {
    match letter {
        "b" => Some(LineEditOp::WordBack),
        "f" => Some(LineEditOp::WordForward),
        "d" => Some(LineEditOp::KillWordForward),
        _ => None,
    }
}

fn is_native_ctrl_key(letter: char) -> bool {
    matches!(letter, 'c' | 'v' | 'x' | 'z')
}

fn letter_of(e: &KeyLike) -> Option<String> {
    let letter = match e.code.as_deref().and_then(|code| code.strip_prefix("Key")) {
        Some(rest) => rest.to_lowercase(),
        None if utf16_len(&e.key) == 1 => e.key.to_lowercase(),
        None => return None,
    };
    (!letter.is_empty()).then_some(letter)
}

fn single_ascii_lower(letter: &str) -> Option<char> {
    let mut chars = letter.chars();
    let first = chars.next()?;
    (chars.next().is_none() && first.is_ascii_lowercase()).then_some(first)
}

pub fn line_edit_op(e: &KeyLike) -> Option<LineEditOp> {
    if e.meta_key || e.shift_key {
        return None;
    }
    let letter = letter_of(e)?;
    if e.ctrl_key && !e.alt_key {
        return ctrl_op(&letter);
    }
    if e.alt_key && !e.ctrl_key {
        return alt_op(&letter);
    }
    None
}

pub fn shell_key_bytes(e: &KeyLike) -> Option<String> {
    if e.meta_key || e.shift_key {
        return None;
    }
    if e.ctrl_key && !e.alt_key {
        let letter = single_ascii_lower(&letter_of(e)?)?;
        if is_native_ctrl_key(letter) {
            return None;
        }
        let code = u8::try_from(u32::from(letter) - 96).ok()?;
        return Some(char::from(code).to_string());
    }
    if e.alt_key && !e.ctrl_key {
        if let Some(letter) = letter_of(e).as_deref().and_then(single_ascii_lower) {
            return Some(format!("\x1b{letter}"));
        }
        let mut chars = e.key.chars();
        if let (Some(first), None) = (chars.next(), chars.next())
            && ('!'..='~').contains(&first)
        {
            return Some(format!("\x1b{first}"));
        }
    }
    None
}

fn is_word_unit(text: &[u16], i: usize) -> bool {
    match text.get(i) {
        None => true,
        Some(unit) => {
            unit_char(*unit).is_some_and(|c| WORD_CHAR.is_match(c.encode_utf8(&mut [0; 4])))
        }
    }
}

fn is_space_unit(text: &[u16], i: usize) -> bool {
    text.get(i)
        .and_then(|unit| unit_char(*unit))
        .is_some_and(is_js_space)
}

fn word_back_from(text: &[u16], caret: usize) -> usize {
    let mut i = caret;
    while i > 0 && !is_word_unit(text, i - 1) {
        i -= 1;
    }
    while i > 0 && is_word_unit(text, i - 1) {
        i -= 1;
    }
    i
}

fn word_forward_from(text: &[u16], caret: usize) -> usize {
    let mut i = caret;
    while i < text.len() && !is_word_unit(text, i) {
        i += 1;
    }
    while i < text.len() && is_word_unit(text, i) {
        i += 1;
    }
    i
}

fn space_word_back_from(text: &[u16], caret: usize) -> usize {
    let mut i = caret;
    while i > 0 && is_space_unit(text, i - 1) {
        i -= 1;
    }
    while i > 0 && !is_space_unit(text, i - 1) {
        i -= 1;
    }
    i
}

fn cut(buf: &LineBuffer, text: &[u16], from: usize, to: usize, caret: usize) -> LineEditResult {
    if from == to {
        return LineEditResult {
            text: buf.text.clone(),
            caret: buf.caret,
            killed: None,
        };
    }
    let mut next = slice(text, 0, from).to_vec();
    next.extend_from_slice(slice(text, to, text.len()));
    LineEditResult {
        text: from_units(&next),
        caret,
        killed: Some(from_units(slice(text, from, to))),
    }
}

fn moved(buf: &LineBuffer, caret: usize) -> LineEditResult {
    LineEditResult {
        text: buf.text.clone(),
        caret,
        killed: None,
    }
}

fn edited(text: &[u16], caret: usize) -> LineEditResult {
    LineEditResult {
        text: from_units(text),
        caret,
        killed: None,
    }
}

pub fn apply_line_edit(op: LineEditOp, buf: &LineBuffer, yank: &str) -> LineEditResult {
    let text = units(&buf.text);
    let caret = buf.caret;
    match op {
        LineEditOp::Home => moved(buf, line_start(&text, caret)),
        LineEditOp::End => moved(buf, line_end(&text, caret)),
        LineEditOp::CharBack => moved(buf, caret.saturating_sub(1)),
        LineEditOp::CharForward => moved(buf, text.len().min(caret + 1)),
        LineEditOp::WordBack => moved(buf, word_back_from(&text, caret)),
        LineEditOp::WordForward => moved(buf, word_forward_from(&text, caret)),
        LineEditOp::KillEnd => {
            let end = line_end(&text, caret);
            let to = if end == caret && end < text.len() {
                end + 1
            } else {
                end
            };
            cut(buf, &text, caret, to, caret)
        }
        LineEditOp::KillStart => {
            let start = line_start(&text, caret);
            cut(buf, &text, start, caret, start)
        }
        LineEditOp::KillWordBack => {
            let start = space_word_back_from(&text, caret);
            cut(buf, &text, start, caret, start)
        }
        LineEditOp::KillWordForward => {
            cut(buf, &text, caret, word_forward_from(&text, caret), caret)
        }
        LineEditOp::DeleteChar => {
            let mut next = slice(&text, 0, caret).to_vec();
            next.extend_from_slice(slice(&text, caret + 1, text.len()));
            edited(&next, caret)
        }
        LineEditOp::Backspace => {
            if caret == 0 {
                return moved(buf, 0);
            }
            let mut next = slice(&text, 0, caret - 1).to_vec();
            next.extend_from_slice(slice(&text, caret, text.len()));
            edited(&next, caret - 1)
        }
        LineEditOp::Yank => {
            if yank.is_empty() {
                return moved(buf, caret);
            }
            let mut next = slice(&text, 0, caret).to_vec();
            next.extend(yank.encode_utf16());
            next.extend_from_slice(slice(&text, caret, text.len()));
            edited(&next, caret + utf16_len(yank))
        }
        LineEditOp::HistoryPrev | LineEditOp::HistoryNext | LineEditOp::ClearScreen => {
            moved(buf, caret)
        }
    }
}
