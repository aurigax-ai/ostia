use bytes::{Bytes, BytesMut};
use ostia_base::js::parse_safe_int;
use serde_json::Value;
use tokio_util::codec::Decoder;

pub const CONTROL_MESSAGE_MAX: usize = 64 * 1024 * 1024;
pub const CONTROL_MESSAGE_ENVELOPE: usize = 64 * 1024;

const HEADER_MAX: usize = 4096;
const CR: u8 = 0x0d;
const LF: u8 = 0x0a;

#[derive(Debug, thiserror::Error)]
pub enum FrameRefused {
    #[error("control message refused")]
    Refused,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub struct FrameCodec {
    max: usize,
    scan_state: u8,
    scanned: usize,
    body: Option<usize>,
}

impl FrameCodec {
    pub fn new(max: usize) -> Self {
        Self {
            max,
            scan_state: 0,
            scanned: 0,
            body: None,
        }
    }

    fn header_end(&mut self, src: &[u8]) -> Option<usize> {
        let mut state = self.scan_state;
        for (at, byte) in src.iter().enumerate().skip(self.scanned) {
            match *byte {
                CR => {
                    state = match state {
                        0 => 1,
                        2 => 3,
                        _ => 0,
                    };
                }
                LF => {
                    if state == 3 {
                        self.scan_state = 0;
                        self.scanned = 0;
                        return Some(at + 1);
                    }
                    state = if state == 1 { 2 } else { 0 };
                }
                _ => state = 0,
            }
        }
        self.scan_state = state;
        self.scanned = src.len();
        None
    }
}

fn declared_length(block: &[u8]) -> Option<i64> {
    let text: String = block.iter().map(|byte| (byte & 0x7f) as char).collect();
    let lines: Vec<&str> = text.split("\r\n").collect();
    let mut found = None;
    let mut count = 0;
    for line in &lines[..lines.len().saturating_sub(2)] {
        let colon = line.find(':')?;
        if !line[..colon].eq_ignore_ascii_case("content-length") {
            continue;
        }
        count += 1;
        found = Some(&line[colon + 1..]);
    }
    if count == 1 {
        parse_safe_int(found?)
    } else {
        None
    }
}

impl Decoder for FrameCodec {
    type Item = Bytes;
    type Error = FrameRefused;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Bytes>, FrameRefused> {
        loop {
            if let Some(length) = self.body {
                if src.len() < length {
                    return Ok(None);
                }
                self.body = None;
                return Ok(Some(src.split_to(length).freeze()));
            }
            let Some(end) = self.header_end(src) else {
                if src.len() > HEADER_MAX {
                    return Err(FrameRefused::Refused);
                }
                return Ok(None);
            };
            let block = src.split_to(end);
            let length = declared_length(&block).ok_or(FrameRefused::Refused)?;
            let length = usize::try_from(length).map_err(|_| FrameRefused::Refused)?;
            if length > self.max {
                return Err(FrameRefused::Refused);
            }
            self.body = Some(length);
        }
    }
}

pub fn encode_frame(message: &Value) -> Vec<u8> {
    let body = message.to_string();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}
