use ostia_base::js::{is_js_space, utf16_len};

use super::utf16_text::{
    from_units, last_newline_before, line_end, line_start, splice, unit_char, units,
};

const NEWLINE: [u16; 1] = [b'\n' as u16];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VimMode {
    Insert,
    Normal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VimMotion {
    H,
    J,
    K,
    L,
    W,
    B,
    E,
    LineStart,
    LineEnd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VimInsert {
    Insert,
    Append,
    LineEnd,
    LineStart,
    OpenBelow,
    OpenAbove,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperatorTarget {
    Motion(VimMotion),
    Line,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VimCommand {
    Move {
        motion: VimMotion,
        count: usize,
    },
    Delete {
        target: OperatorTarget,
        count: usize,
    },
    Change {
        target: OperatorTarget,
        count: usize,
    },
    DeleteChar {
        count: usize,
    },
    Insert {
        at: VimInsert,
    },
    Undo {
        count: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VimParse {
    Command(VimCommand),
    Pending,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VimBuffer {
    pub text: String,
    pub caret: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VimResult {
    pub text: String,
    pub caret: usize,
    pub mode: VimMode,
}

fn motion_of(key: char) -> Option<VimMotion> {
    match key {
        'h' => Some(VimMotion::H),
        'j' => Some(VimMotion::J),
        'k' => Some(VimMotion::K),
        'l' => Some(VimMotion::L),
        'w' => Some(VimMotion::W),
        'b' => Some(VimMotion::B),
        'e' => Some(VimMotion::E),
        '0' => Some(VimMotion::LineStart),
        '$' => Some(VimMotion::LineEnd),
        _ => None,
    }
}

fn operator_motion_of(key: char) -> Option<VimMotion> {
    motion_of(key).filter(|motion| !matches!(motion, VimMotion::J | VimMotion::K))
}

fn insert_of(key: char) -> Option<VimInsert> {
    match key {
        'i' => Some(VimInsert::Insert),
        'a' => Some(VimInsert::Append),
        'A' => Some(VimInsert::LineEnd),
        'I' => Some(VimInsert::LineStart),
        'o' => Some(VimInsert::OpenBelow),
        'O' => Some(VimInsert::OpenAbove),
        _ => None,
    }
}

fn split_count(keys: &str) -> (usize, &str) {
    let mut chars = keys.chars();
    if !matches!(chars.next(), Some('1'..='9')) {
        return (1, keys);
    }
    let digits_len = keys
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(keys.len());
    let count = keys[..digits_len].parse().unwrap_or(usize::MAX);
    (count, &keys[digits_len..])
}

pub fn parse_vim_keys(keys: &str) -> VimParse {
    let (count, rest) = split_count(keys);
    let Some(head) = rest.chars().next() else {
        return VimParse::Pending;
    };
    if head == 'd' || head == 'c' {
        let (inner_count, inner_rest) = split_count(&rest[1..]);
        let Some(inner_head) = inner_rest.chars().next() else {
            return VimParse::Pending;
        };
        if utf16_len(inner_rest) > 1 {
            return VimParse::Rejected;
        }
        let total = count.saturating_mul(inner_count);
        let target = if inner_head == head {
            OperatorTarget::Line
        } else {
            match operator_motion_of(inner_head) {
                Some(motion) => OperatorTarget::Motion(motion),
                None => return VimParse::Rejected,
            }
        };
        return VimParse::Command(if head == 'd' {
            VimCommand::Delete {
                target,
                count: total,
            }
        } else {
            VimCommand::Change {
                target,
                count: total,
            }
        });
    }
    if utf16_len(rest) > 1 {
        return VimParse::Rejected;
    }
    let command = match head {
        'x' => VimCommand::DeleteChar { count },
        'u' => VimCommand::Undo { count },
        'D' => VimCommand::Delete {
            target: OperatorTarget::Motion(VimMotion::LineEnd),
            count: 1,
        },
        'C' => VimCommand::Change {
            target: OperatorTarget::Motion(VimMotion::LineEnd),
            count: 1,
        },
        _ => {
            if let Some(at) = insert_of(head) {
                VimCommand::Insert { at }
            } else if let Some(motion) = motion_of(head) {
                VimCommand::Move { motion, count }
            } else {
                return VimParse::Rejected;
            }
        }
    };
    VimParse::Command(command)
}

fn last_column(text: &[u16], pos: usize) -> usize {
    line_start(text, pos).max(line_end(text, pos).saturating_sub(1))
}

fn clamp_normal_units(text: &[u16], caret: usize) -> usize {
    let pos = caret.min(text.len());
    pos.min(last_column(text, pos))
}

pub fn clamp_normal(text: &str, caret: usize) -> usize {
    clamp_normal_units(&units(text), caret)
}

fn char_class(unit: Option<u16>) -> u8 {
    let Some(c) = unit.and_then(unit_char) else {
        return if unit.is_some() { 2 } else { 0 };
    };
    if is_js_space(c) {
        0
    } else if c.is_ascii_alphanumeric() || c == '_' {
        1
    } else {
        2
    }
}

fn class_at(text: &[u16], i: usize) -> u8 {
    char_class(text.get(i).copied())
}

fn next_word_start(text: &[u16], pos: usize) -> usize {
    let mut i = pos;
    let cls = class_at(text, i);
    if cls != 0 {
        while i < text.len() && class_at(text, i) == cls {
            i += 1;
        }
    }
    while i < text.len() && class_at(text, i) == 0 {
        i += 1;
    }
    i
}

fn prev_word_start(text: &[u16], pos: usize) -> usize {
    let Some(mut i) = pos.checked_sub(1) else {
        return 0;
    };
    while i > 0 && class_at(text, i) == 0 {
        i -= 1;
    }
    let cls = class_at(text, i);
    while i > 0 && class_at(text, i - 1) == cls {
        i -= 1;
    }
    i
}

fn word_end(text: &[u16], pos: usize) -> usize {
    let mut i = pos + 1;
    while i < text.len() && class_at(text, i) == 0 {
        i += 1;
    }
    let cls = class_at(text, i);
    while i + 1 < text.len() && class_at(text, i + 1) == cls {
        i += 1;
    }
    i.min(text.len().saturating_sub(1))
}

fn repeat(count: usize, pos: usize, step: impl Fn(usize) -> usize) -> usize {
    let mut p = pos;
    for _ in 0..count {
        let next = step(p);
        if next == p {
            break;
        }
        p = next;
    }
    p
}

fn vertical_target(text: &[u16], caret: usize, down: bool, count: usize) -> usize {
    let mut pos = caret;
    let column = caret as i64 - line_start(text, caret) as i64;
    for _ in 0..count {
        if down {
            let end = line_end(text, pos);
            if end >= text.len() {
                break;
            }
            pos = end + 1;
        } else {
            let start = line_start(text, pos);
            if start == 0 {
                break;
            }
            pos = line_start(text, start - 1);
        }
    }
    let start = line_start(text, pos);
    let wanted = usize::try_from(start as i64 + column).unwrap_or(0);
    wanted.min(last_column(text, start))
}

fn motion_target(text: &[u16], caret: usize, motion: VimMotion, count: usize) -> usize {
    match motion {
        VimMotion::H => line_start(text, caret).max(caret.saturating_sub(count)),
        VimMotion::L => last_column(text, caret).min(caret.saturating_add(count)),
        VimMotion::LineStart => line_start(text, caret),
        VimMotion::LineEnd => last_column(text, caret),
        VimMotion::W => repeat(count, caret, |p| next_word_start(text, p)),
        VimMotion::B => repeat(count, caret, |p| prev_word_start(text, p)),
        VimMotion::E => repeat(count, caret, |p| word_end(text, p)),
        VimMotion::J => vertical_target(text, caret, true, count),
        VimMotion::K => vertical_target(text, caret, false, count),
    }
}

pub fn can_move_vertically(text: &str, caret: usize, down: bool) -> bool {
    let text = units(text);
    if down {
        line_end(&text, caret) < text.len()
    } else {
        line_start(&text, caret) > 0
    }
}

fn operator_range(
    text: &[u16],
    caret: usize,
    motion: VimMotion,
    count: usize,
    change: bool,
) -> (usize, usize) {
    match motion {
        VimMotion::H | VimMotion::B | VimMotion::LineStart => {
            (motion_target(text, caret, motion, count), caret)
        }
        VimMotion::L => (
            caret,
            line_end(text, caret).min(caret.saturating_add(count)),
        ),
        VimMotion::LineEnd => (caret, line_end(text, caret)),
        VimMotion::E => (
            caret,
            text.len()
                .min(motion_target(text, caret, VimMotion::E, count) + 1),
        ),
        VimMotion::W | VimMotion::J | VimMotion::K => {
            let mut to = motion_target(text, caret, VimMotion::W, count);
            if change && class_at(text, caret) != 0 {
                while to > caret && class_at(text, to - 1) == 0 {
                    to -= 1;
                }
                return (caret, to);
            }
            let from = i64::try_from(to).unwrap_or(i64::MAX) - 1;
            let newline = last_newline_before(text, from);
            (caret, newline.filter(|at| *at >= caret).unwrap_or(to))
        }
    }
}

fn lines_range(text: &[u16], caret: usize, count: usize) -> (usize, usize) {
    let start = line_start(text, caret);
    let mut end = line_end(text, caret);
    let mut n = 1;
    while n < count && end < text.len() {
        end = line_end(text, end + 1);
        n += 1;
    }
    (start, end)
}

fn first_non_blank(text: &[u16], caret: usize) -> usize {
    let mut i = line_start(text, caret);
    let end = line_end(text, caret);
    while i < end && matches!(text.get(i), Some(0x20 | 0x09)) {
        i += 1;
    }
    i
}

fn result(text: &[u16], caret: usize, mode: VimMode) -> VimResult {
    VimResult {
        text: from_units(text),
        caret,
        mode,
    }
}

fn apply_insert(buffer: &VimBuffer, text: &[u16], caret: usize, at: VimInsert) -> VimResult {
    let start = line_start(text, caret);
    let end = line_end(text, caret);
    let unchanged = |caret| VimResult {
        text: buffer.text.clone(),
        caret,
        mode: VimMode::Insert,
    };
    match at {
        VimInsert::Insert => unchanged(caret),
        VimInsert::Append => unchanged(end.min(caret + 1)),
        VimInsert::LineEnd => unchanged(end),
        VimInsert::LineStart => unchanged(first_non_blank(text, caret)),
        VimInsert::OpenBelow => result(&splice(text, end, end, &NEWLINE), end + 1, VimMode::Insert),
        VimInsert::OpenAbove => result(
            &splice(text, start, start, &NEWLINE),
            start,
            VimMode::Insert,
        ),
    }
}

fn apply_lines(text: &[u16], caret: usize, count: usize, change: bool) -> VimResult {
    let (start, end) = lines_range(text, caret, count);
    if change {
        return result(&splice(text, start, end, &[]), start, VimMode::Insert);
    }
    if end < text.len() {
        let next = splice(text, start, end + 1, &[]);
        let at = clamp_normal_units(&next, start);
        return result(&next, at, VimMode::Normal);
    }
    let from = start.saturating_sub(1);
    let next = splice(text, from, end, &[]);
    let at = clamp_normal_units(&next, line_start(&next, from));
    result(&next, at, VimMode::Normal)
}

pub fn apply_vim_command(command: &VimCommand, buffer: &VimBuffer) -> VimResult {
    let text = units(&buffer.text);
    let caret = buffer.caret;
    match *command {
        VimCommand::Move { motion, count } => VimResult {
            text: buffer.text.clone(),
            caret: clamp_normal_units(&text, motion_target(&text, caret, motion, count)),
            mode: VimMode::Normal,
        },
        VimCommand::DeleteChar { count } => {
            let to = line_end(&text, caret).min(caret.saturating_add(count));
            let next = splice(&text, caret, to, &[]);
            let at = clamp_normal_units(&next, caret);
            result(&next, at, VimMode::Normal)
        }
        VimCommand::Insert { at } => apply_insert(buffer, &text, caret, at),
        VimCommand::Undo { .. } => VimResult {
            text: buffer.text.clone(),
            caret,
            mode: VimMode::Normal,
        },
        VimCommand::Delete { target, count } | VimCommand::Change { target, count } => {
            let change = matches!(command, VimCommand::Change { .. });
            let motion = match target {
                OperatorTarget::Line => return apply_lines(&text, caret, count, change),
                OperatorTarget::Motion(motion) => motion,
            };
            let (from, to) = operator_range(&text, caret, motion, count, change);
            let next = splice(&text, from, to, &[]);
            if change {
                return result(&next, from, VimMode::Insert);
            }
            let at = clamp_normal_units(&next, from);
            result(&next, at, VimMode::Normal)
        }
    }
}

pub fn enter_normal(buffer: &VimBuffer) -> VimResult {
    let text = units(&buffer.text);
    let caret = buffer.caret;
    let back = if caret > line_start(&text, caret) {
        caret - 1
    } else {
        caret
    };
    VimResult {
        text: buffer.text.clone(),
        caret: clamp_normal_units(&text, back),
        mode: VimMode::Normal,
    }
}
