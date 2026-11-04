use ostia_base::js::js_number;

const MAX_SEQUENCE: usize = 256;
const MAX_OSC: usize = 65_536;
const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Escape,
    Csi,
    Osc,
    OscEscape,
    OtherString,
    OtherStringEscape,
}

pub(crate) enum Sequence {
    Csi {
        prefix: String,
        intermediates: String,
        final_byte: u8,
        params: String,
    },
    Osc(String),
}

pub(crate) struct Observer {
    state: State,
    body: String,
    osc: Vec<u8>,
}

impl Observer {
    pub(crate) fn new() -> Self {
        Self {
            state: State::Ground,
            body: String::new(),
            osc: Vec::new(),
        }
    }

    pub(crate) fn step(&mut self, byte: u8) -> Option<Sequence> {
        match self.state {
            State::Ground => {
                if byte == ESC {
                    self.state = State::Escape;
                }
                None
            }
            State::Escape => {
                self.escape_byte(byte);
                None
            }
            State::OtherString => {
                if byte == BEL || byte == CAN || byte == SUB {
                    self.state = State::Ground;
                } else if byte == ESC {
                    self.state = State::OtherStringEscape;
                }
                None
            }
            State::OtherStringEscape => {
                if byte == b'\\' {
                    self.state = State::Ground;
                } else {
                    self.escape_byte(byte);
                }
                None
            }
            State::Osc => {
                if byte == BEL {
                    self.state = State::Ground;
                    return Some(Sequence::Osc(self.take_osc()));
                }
                if byte == CAN || byte == SUB {
                    self.state = State::Ground;
                } else if byte == ESC {
                    self.state = State::OscEscape;
                } else if self.osc.len() < MAX_OSC {
                    self.osc.push(byte);
                }
                None
            }
            State::OscEscape => {
                if byte == b'\\' {
                    self.state = State::Ground;
                    return Some(Sequence::Osc(self.take_osc()));
                }
                self.escape_byte(byte);
                None
            }
            State::Csi => self.csi_byte(byte),
        }
    }

    fn escape_byte(&mut self, byte: u8) {
        if byte == b'[' {
            self.state = State::Csi;
            self.body.clear();
        } else if byte == b']' {
            self.state = State::Osc;
            self.osc.clear();
        } else if matches!(byte, b'P' | b'_' | b'^' | b'X') {
            self.state = State::OtherString;
        } else if byte == ESC {
            self.state = State::Escape;
        } else {
            self.state = State::Ground;
        }
    }

    fn take_osc(&mut self) -> String {
        let bytes = std::mem::take(&mut self.osc);
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn csi_byte(&mut self, byte: u8) -> Option<Sequence> {
        if (0x40..=0x7e).contains(&byte) {
            self.state = State::Ground;
            return parse_csi(&self.body, byte);
        }
        if byte == ESC {
            self.state = State::Escape;
            return None;
        }
        if !(0x20..=0x3f).contains(&byte) {
            if byte == CAN || byte == SUB {
                self.state = State::Ground;
            }
            return None;
        }
        self.body.push(char::from(byte));
        if self.body.len() > MAX_SEQUENCE {
            self.state = State::Ground;
        }
        None
    }
}

fn parse_csi(body: &str, final_byte: u8) -> Option<Sequence> {
    let mut rest = body;
    let prefix = match rest.chars().next() {
        Some(ch @ ('<' | '=' | '>' | '?')) => {
            rest = &rest[1..];
            ch.to_string()
        }
        _ => String::new(),
    };
    let params_end = rest
        .find(|ch: char| !(ch.is_ascii_digit() || ch == ';' || ch == ':'))
        .unwrap_or(rest.len());
    let (params, intermediates) = rest.split_at(params_end);
    if !intermediates.chars().all(|ch| (' '..='/').contains(&ch)) {
        return None;
    }
    Some(Sequence::Csi {
        prefix,
        intermediates: intermediates.to_string(),
        final_byte,
        params: params.to_string(),
    })
}

pub(crate) fn first_param(params: &str) -> f64 {
    let first = params.split(';').next().unwrap_or("");
    if first.is_empty() {
        return 0.0;
    }
    let head = first.split(':').next().unwrap_or("");
    if head.is_empty() {
        0.0
    } else {
        js_number(head)
    }
}

fn is_alternate_screen_mode(code: f64) -> bool {
    code == 47.0 || code == 1047.0 || code == 1049.0
}

pub(crate) fn any_alternate_screen_mode(params: &str) -> bool {
    if params.is_empty() {
        return false;
    }
    params.split(';').any(|part| {
        let head = part.split(':').next().unwrap_or("");
        let code = if head.is_empty() {
            0.0
        } else {
            js_number(head)
        };
        is_alternate_screen_mode(code)
    })
}
