use std::collections::HashSet;

use ostia_base::clock::Clock;
use ostia_base::js::js_trim;
use ostia_contract::pty_api::HumanInputSource;
use serde_json::Value;

pub const HUMAN_PROMPT_WINDOW_MS: i64 = 10_000;

const ESC: u16 = 0x1b;
const DEL: u16 = 0x7f;
const ENTER: u16 = 0x0d;
const LINE_FEED: u16 = 0x0a;
const BEL: u16 = 0x07;
const SPACE: u16 = 0x20;
const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";
const LINE_CLEARS: [u16; 2] = [0x03, 0x15];

pub fn human_input_source(raw: &Value) -> Option<HumanInputSource> {
    match raw.as_str() {
        Some("key") => Some(HumanInputSource::Key),
        Some("paste") => Some(HumanInputSource::Paste),
        _ => None,
    }
}

fn units_start_with(data: &[u16], at: usize, prefix: &str) -> bool {
    prefix
        .encode_utf16()
        .enumerate()
        .all(|(offset, unit)| data.get(at + offset) == Some(&unit))
}

fn in_range(unit: u16, low: u8, high: u8) -> bool {
    unit >= u16::from(low) && unit <= u16::from(high)
}

fn escape_end(data: &[u16], at: usize) -> usize {
    let len = data.len();
    let kind = data.get(at + 1).copied();
    if kind == Some(u16::from(b'[')) {
        if data.get(at + 2) == Some(&u16::from(b'M')) {
            return (at + 6).min(len);
        }
        let mut i = at + 2;
        while i < len && in_range(data[i], b'0', b'?') {
            i += 1;
        }
        while i < len && in_range(data[i], b' ', b'/') {
            i += 1;
        }
        return (i + 1).min(len);
    }
    if kind == Some(u16::from(b']')) || kind == Some(u16::from(b'P')) {
        let mut i = at + 2;
        while i < len && data[i] != BEL && !units_start_with(data, i, "\x1b\\") {
            i += 1;
        }
        let end = if data.get(i) == Some(&BEL) { 1 } else { 2 };
        return (i + end).min(len);
    }
    let width = if kind == Some(u16::from(b'O')) { 3 } else { 2 };
    (at + width).min(len)
}

struct Submitted {
    human: bool,
    text: String,
    at: i64,
    claimed: HashSet<String>,
}

pub struct PaneInput {
    now: Clock,
    foreign: bool,
    pasting: bool,
    edited: bool,
    text: Vec<char>,
    submitted: Option<Submitted>,
    noted: u64,
}

impl PaneInput {
    pub fn new(now: Clock) -> Self {
        Self {
            now,
            foreign: false,
            pasting: false,
            edited: false,
            text: Vec::new(),
            submitted: None,
            noted: 0,
        }
    }

    pub fn writes(&self) -> u64 {
        self.noted
    }

    pub fn drafting(&self) -> bool {
        !self.text.is_empty() || self.edited || self.foreign
    }

    pub fn note(&mut self, data: &str, source: Option<HumanInputSource>) {
        self.noted += 1;
        if source == Some(HumanInputSource::Key) {
            self.pasting = false;
        }
        let units: Vec<u16> = data.encode_utf16().collect();
        let mut i = 0;
        while i < units.len() {
            let c = units[i];
            if c == ESC {
                if units_start_with(&units, i, PASTE_START) {
                    self.pasting = true;
                } else if units_start_with(&units, i, PASTE_END) {
                    self.pasting = false;
                } else if source.is_some() {
                    self.edited = true;
                }
                i = escape_end(&units, i);
                continue;
            }
            let (point, width) = match char::decode_utf16(units[i..].iter().copied()).next() {
                Some(Ok(point)) => (point, point.len_utf16()),
                _ => (char::REPLACEMENT_CHARACTER, 1),
            };
            i += width;
            if c == ENTER {
                if source.is_none() && !self.text.is_empty() {
                    self.foreign = true;
                }
                if !self.pasting && source != Some(HumanInputSource::Paste) {
                    self.submit();
                } else if source.is_some() {
                    self.text.push('\n');
                }
            } else if c == DEL {
                if source.is_some() {
                    self.text.pop();
                }
            } else if c < SPACE {
                if source.is_none() {
                    continue;
                }
                if LINE_CLEARS.contains(&c) {
                    self.foreign = false;
                    self.edited = false;
                    self.text.clear();
                } else if c == LINE_FEED {
                    self.text.push('\n');
                } else {
                    self.edited = true;
                }
            } else if source.is_none() {
                self.foreign = true;
            } else {
                self.text.push(point);
            }
        }
    }

    pub fn claim_human_prompt(&mut self, claimant: &str) -> Option<String> {
        let now = (self.now)();
        let last = self.submitted.as_mut()?;
        if !last.human || last.text.is_empty() || now - last.at > HUMAN_PROMPT_WINDOW_MS {
            return None;
        }
        if !last.claimed.insert(claimant.to_owned()) {
            return None;
        }
        Some(last.text.clone())
    }

    fn submit(&mut self) {
        let joined: String = self.text.iter().collect();
        self.submitted = Some(Submitted {
            human: !self.foreign && !self.edited,
            text: js_trim(&joined).to_owned(),
            at: (self.now)(),
            claimed: HashSet::new(),
        });
        self.foreign = false;
        self.edited = false;
        self.text.clear();
    }
}
