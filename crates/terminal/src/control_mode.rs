use std::collections::HashMap;

use ostia_base::js::js_number;

const BACKSLASH: u8 = 0x5c;
const NEWLINE: u8 = 0x0a;
const SPACE: u8 = 0x20;
const OUTPUT_PREFIX: &[u8] = b"%output ";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlEvent {
    Output {
        pane: String,
        data: String,
    },
    Reply {
        ok: bool,
        lines: Vec<String>,
    },
    Subscription {
        name: String,
        pane: String,
        value: String,
    },
    Exit {
        reason: String,
    },
}

fn is_octal_digit(byte: Option<&u8>) -> Option<u8> {
    byte.copied().filter(|b| (0x30..=0x37).contains(b))
}

fn unescape_output(escaped: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(escaped.len());
    let mut i = 0;
    while i < escaped.len() {
        let byte = escaped[i];
        if byte == BACKSLASH
            && let (Some(a), Some(b), Some(c)) = (
                is_octal_digit(escaped.get(i + 1)),
                is_octal_digit(escaped.get(i + 2)),
                is_octal_digit(escaped.get(i + 3)),
            )
        {
            let value =
                (u32::from(a - 0x30) << 6) | (u32::from(b - 0x30) << 3) | u32::from(c - 0x30);
            out.push((value & 0xff) as u8);
            i += 4;
        } else {
            out.push(byte);
            i += 1;
        }
    }
    out
}

fn is_odd_flag(word: Option<&&str>) -> bool {
    let value = word.map_or(f64::NAN, |word| js_number(word));
    value.is_finite() && value.trunc().rem_euclid(2.0) == 1.0
}

fn decode_utf8(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    let mut text = String::new();
    let mut rest: &[u8] = pending;
    let mut keep = 0;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                text.push_str(valid);
                break;
            }
            Err(error) => {
                let (valid, after) = rest.split_at(error.valid_up_to());
                text.push_str(&String::from_utf8_lossy(valid));
                match error.error_len() {
                    Some(length) => {
                        text.push('\u{fffd}');
                        rest = &after[length..];
                    }
                    None => {
                        keep = after.len();
                        break;
                    }
                }
            }
        }
    }
    let tail = pending[pending.len() - keep..].to_vec();
    *pending = tail;
    text
}

struct OpenReply {
    number: String,
    ours: bool,
    lines: Vec<String>,
}

#[derive(Default)]
pub struct ControlModeParser {
    pending: Vec<u8>,
    reply: Option<OpenReply>,
    decoders: HashMap<String, Vec<u8>>,
}

impl ControlModeParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<ControlEvent> {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(chunk);
        let mut events = Vec::new();
        let mut start = 0;
        while let Some(offset) = data[start..].iter().position(|&b| b == NEWLINE) {
            self.line(&data[start..start + offset], &mut events);
            start += offset + 1;
        }
        self.pending = data.split_off(start);
        events
    }

    pub fn forget_pane(&mut self, pane: &str) {
        self.decoders.remove(pane);
    }

    fn line(&mut self, raw: &[u8], events: &mut Vec<ControlEvent>) {
        if self.reply.is_some() {
            self.reply_line(&String::from_utf8_lossy(raw), events);
            return;
        }
        if raw.starts_with(OUTPUT_PREFIX) {
            let Some(offset) = raw[OUTPUT_PREFIX.len()..].iter().position(|&b| b == SPACE) else {
                return;
            };
            let pane_end = OUTPUT_PREFIX.len() + offset;
            let pane: String = raw[OUTPUT_PREFIX.len()..pane_end]
                .iter()
                .map(|&b| char::from(b))
                .collect();
            let bytes = unescape_output(&raw[pane_end + 1..]);
            self.output(pane, &bytes, events);
            return;
        }
        self.notification(&String::from_utf8_lossy(raw), events);
    }

    fn reply_line(&mut self, text: &str, events: &mut Vec<ControlEvent>) {
        let Some(reply) = self.reply.as_mut() else {
            return;
        };
        let mut words = text.split(' ');
        let word = words.next();
        let number = words.nth(1);
        if matches!(word, Some("%end" | "%error")) && number == Some(reply.number.as_str()) {
            if let Some(reply) = self.reply.take()
                && reply.ours
            {
                events.push(ControlEvent::Reply {
                    ok: word == Some("%end"),
                    lines: reply.lines,
                });
            }
            return;
        }
        reply.lines.push(text.to_owned());
    }

    fn notification(&mut self, text: &str, events: &mut Vec<ControlEvent>) {
        let words: Vec<&str> = text.split(' ').collect();
        match words[0] {
            "%begin" => {
                self.reply = Some(OpenReply {
                    number: words.get(2).copied().unwrap_or_default().to_owned(),
                    ours: is_odd_flag(words.get(3)),
                    lines: Vec::new(),
                });
            }
            "%exit" => events.push(ControlEvent::Exit {
                reason: words[1..].join(" "),
            }),
            "%subscription-changed" => {
                let Some(colon) = text.find(" : ") else {
                    return;
                };
                events.push(ControlEvent::Subscription {
                    name: words.get(1).copied().unwrap_or_default().to_owned(),
                    pane: words.get(5).copied().unwrap_or_default().to_owned(),
                    value: text[colon + 3..].to_owned(),
                });
            }
            _ => {}
        }
    }

    fn output(&mut self, pane: String, bytes: &[u8], events: &mut Vec<ControlEvent>) {
        let pending = self.decoders.entry(pane.clone()).or_default();
        let data = decode_utf8(pending, bytes);
        if !data.is_empty() {
            events.push(ControlEvent::Output { pane, data });
        }
    }
}
