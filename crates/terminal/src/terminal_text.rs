const ESC: char = '\x1b';
const BEL: char = '\x07';
const ESC_UNIT: u16 = 0x1b;
const BEL_UNIT: u16 = 0x07;
const BACKSLASH_UNIT: u16 = b'\\' as u16;
const SEMICOLON_UNIT: u16 = b';' as u16;
const PROMPT_MARK: [u16; 6] = [
    ESC_UNIT,
    b']' as u16,
    b'1' as u16,
    b'3' as u16,
    b'3' as u16,
    SEMICOLON_UNIT,
];
const PROMPT_MARK_MAX: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptMark {
    pub kind: String,
    pub arg: Option<String>,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlainTerminalText {
    pub text: String,
    pub consumed: usize,
}

struct StringEnd {
    body_end: usize,
    end: usize,
}

fn string_end(raw: &[char], from: usize) -> Option<StringEnd> {
    let mut i = from;
    while i < raw.len() {
        if raw[i] == BEL {
            return Some(StringEnd {
                body_end: i,
                end: i + 1,
            });
        }
        if raw[i] != ESC {
            i += 1;
            continue;
        }
        let next = raw.get(i + 1)?;
        return Some(StringEnd {
            body_end: i,
            end: if *next == '\\' { i + 2 } else { i },
        });
    }
    None
}

fn escape_end(raw: &[char], at: usize) -> Option<usize> {
    let introducer = *raw.get(at + 1)?;
    if matches!(introducer, ']' | 'P' | 'X' | '^' | '_') {
        return string_end(raw, at + 2).map(|found| found.end);
    }
    let csi = introducer == '[';
    let start = if csi { at + 2 } else { at + 1 };
    for (i, ch) in raw.iter().enumerate().skip(start) {
        let code = u32::from(*ch);
        let is_final = if csi {
            (0x40..=0x7e).contains(&code)
        } else {
            (0x30..=0x7e).contains(&code)
        };
        if is_final {
            return Some(i + 1);
        }
    }
    None
}

pub fn plain_terminal_text(raw: &str) -> PlainTerminalText {
    let chars: Vec<char> = raw.chars().collect();
    let mut text = String::new();
    let mut line = String::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == ESC {
            let Some(end) = escape_end(&chars, i) else {
                break;
            };
            i = end;
            continue;
        }
        match ch {
            '\n' => {
                text.push_str(&line);
                text.push('\n');
                line.clear();
            }
            '\r' => {
                let Some(next) = chars.get(i + 1) else {
                    break;
                };
                if *next != '\n' {
                    line.clear();
                }
            }
            '\u{8}' => {
                line.pop();
            }
            '\t' => line.push(ch),
            _ if ch >= ' ' && ch != '\x7f' => line.push(ch),
            _ => {}
        }
        i += 1;
    }
    text.push_str(&line);
    PlainTerminalText {
        text,
        consumed: chars[..i].iter().map(|ch| ch.len_utf16()).sum(),
    }
}

fn unit_string_end(units: &[u16], from: usize) -> Option<StringEnd> {
    let mut i = from;
    while i < units.len() {
        if units[i] == BEL_UNIT {
            return Some(StringEnd {
                body_end: i,
                end: i + 1,
            });
        }
        if units[i] != ESC_UNIT {
            i += 1;
            continue;
        }
        let next = units.get(i + 1)?;
        return Some(StringEnd {
            body_end: i,
            end: if *next == BACKSLASH_UNIT { i + 2 } else { i },
        });
    }
    None
}

fn find_prompt_mark(units: &[u16], from: usize) -> Option<usize> {
    units
        .get(from..)?
        .windows(PROMPT_MARK.len())
        .position(|window| window == PROMPT_MARK)
        .map(|offset| from + offset)
}

fn partial_mark_suffix(data: &[u16]) -> Vec<u16> {
    for len in (1..=(PROMPT_MARK.len() - 1).min(data.len())).rev() {
        if data.ends_with(&PROMPT_MARK[..len]) {
            return data[data.len() - len..].to_vec();
        }
    }
    Vec::new()
}

#[derive(Default)]
pub struct PromptMarkScanner {
    carry: Vec<u16>,
}

impl PromptMarkScanner {
    pub fn scan(&mut self, data: &str, end_cursor: usize) -> Vec<PromptMark> {
        let mut combined = std::mem::take(&mut self.carry);
        combined.extend(data.encode_utf16());
        let base = end_cursor.saturating_sub(combined.len());
        let mut marks = Vec::new();
        let mut from = 0;
        loop {
            let Some(at) = find_prompt_mark(&combined, from) else {
                self.carry = partial_mark_suffix(&combined[from..]);
                return marks;
            };
            let body_start = at + PROMPT_MARK.len();
            let Some(found) = unit_string_end(&combined, body_start) else {
                if combined.len() - at <= PROMPT_MARK_MAX {
                    self.carry = combined[at..].to_vec();
                }
                return marks;
            };
            let body = String::from_utf16_lossy(&combined[body_start..found.body_end]);
            let mut parts = body.split(';');
            let kind = parts.next().unwrap_or("").to_owned();
            let arg = parts.next().map(str::to_owned);
            marks.push(PromptMark {
                kind,
                arg,
                start: base + at,
                end: base + found.end,
            });
            from = found.end.max(body_start);
        }
    }
}
