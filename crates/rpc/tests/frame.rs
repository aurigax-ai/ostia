#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bytes::BytesMut;
use ostia_rpc::{FrameCodec, FrameRefused, parse_body};
use tokio_util::codec::Decoder;

struct Connection {
    codec: FrameCodec,
    buffer: BytesMut,
    messages: usize,
    closed: bool,
}

impl Connection {
    fn new(max: usize) -> Self {
        Self {
            codec: FrameCodec::new(max),
            buffer: BytesMut::new(),
            messages: 0,
            closed: false,
        }
    }

    fn send(&mut self, data: &[u8]) {
        if self.closed {
            return;
        }
        self.buffer.extend_from_slice(data);
        loop {
            match self.codec.decode(&mut self.buffer) {
                Ok(Some(body)) => {
                    if parse_body(&body).is_err() {
                        self.closed = true;
                        return;
                    }
                    self.messages += 1;
                }
                Ok(None) => return,
                Err(FrameRefused::Refused | FrameRefused::Io(_)) => {
                    self.closed = true;
                    return;
                }
            }
        }
    }
}

fn frame(length: usize, body: &[u8]) -> Vec<u8> {
    let mut out = format!("Content-Length: {length}\r\n\r\n").into_bytes();
    out.extend_from_slice(body);
    out
}

fn json_frame(text: &str) -> Vec<u8> {
    frame(text.len(), text.as_bytes())
}

#[test]
fn passes_messages_up_to_the_cap_split_anywhere_and_several_at_once() {
    let mut conn = Connection::new(200);
    let one = json_frame(r#"{"jsonrpc":"2.0","method":"a"}"#);
    conn.send(&[one.clone(), one.clone()].concat());
    for byte in &one {
        conn.send(&[*byte]);
    }
    assert!(!conn.closed);
    assert_eq!(conn.messages, 3);
}

#[test]
fn closes_when_a_message_declares_more_than_the_cap() {
    let mut conn = Connection::new(10);
    conn.send(&frame(11, &[0; 11]));
    assert!(conn.closed);
    assert_eq!(conn.messages, 0);
}

#[test]
fn closes_on_two_content_length_headers_whichever_comes_first() {
    for block in [
        "Content-Length: 1\r\nContent-Length: 2000000000\r\n\r\n",
        "Content-Length: 2000000000\r\nContent-Length: 1\r\n\r\n",
        "content-length: 1\r\nCONTENT-LENGTH: 1\r\n\r\n",
    ] {
        let mut conn = Connection::new(10);
        conn.send(block.as_bytes());
        assert!(conn.closed, "{block}");
    }
}

#[test]
fn reads_the_length_as_the_reader_does_and_refuses_the_rest() {
    let mut ok = Connection::new(100);
    ok.send(b"X-Other: y\r\nCONTENT-length:  7abc \r\n\r\n1234567");
    assert!(!ok.closed);
    assert_eq!(ok.messages, 1);
    for block in [
        "Content-Length: -5\r\n\r\n",
        "Content-Length: x\r\n\r\n",
        "broken\r\n\r\n",
        "X: y\r\n\r\n",
    ] {
        let mut bad = Connection::new(100);
        bad.send(block.as_bytes());
        assert!(bad.closed, "{block}");
    }
}

#[test]
fn a_second_cr_resets_the_header_scan_and_cannot_hide_a_header() {
    let hidden = format!("{:x<40}", "Content-Length: 200000000\r\n\r\n");
    let attacks = [
        format!("Content-Length: 5\r\r\n\r\nAAAAAContent-Length: 40\r\n\r\n{hidden}"),
        format!("Content-Length: 5\r\n\r\r\n\r\nAAAAAContent-Length: 40\r\n\r\n{hidden}"),
        "Content-Length: 5\r\r\n\r\nAAAAAContent-Length: 1000\r\n\r\n".to_owned(),
        "Content-Length: 5\r\r\n\r\nAAAAAContent-Length: 1000\r\nContent-Length: 200000000\r\n\r\n"
            .to_owned(),
        "Content-Length: 5\r\n\r\r\n\r\nAAAAA".to_owned(),
        "Content-Length: 1\n\r\n\r\nAContent-Length: 200000000\r\n\r\n".to_owned(),
        "Content-Length: 1\r\n\n\r\nAContent-Length: 200000000\r\n\r\n".to_owned(),
    ];
    for attack in attacks {
        let mut conn = Connection::new(50);
        conn.send(attack.as_bytes());
        conn.send(&frame(50, &[0; 50]));
        assert!(conn.closed, "{attack:?}");
    }
}

#[test]
fn counts_the_body_of_a_big_allowed_message_and_then_refuses_a_big_one() {
    let mut conn = Connection::new(1024);
    let body = format!(
        r#"{{"jsonrpc":"2.0","method":"big","params":"{}"}}"#,
        "x".repeat(900)
    );
    conn.send(&frame(body.len(), &body.as_bytes()[..300]));
    conn.send(&body.as_bytes()[300..]);
    conn.send(&json_frame(r#"{"jsonrpc":"2.0","method":"next"}"#));
    assert!(!conn.closed);
    assert_eq!(conn.messages, 2);
    conn.send(&frame(5000, &[]));
    assert!(conn.closed);
}

#[test]
fn closes_when_a_header_never_ends_and_passes_the_limit() {
    let mut conn = Connection::new(100);
    conn.send(&vec![b'a'; 4097]);
    assert!(conn.closed);
}

#[test]
fn closes_on_a_body_that_is_not_json() {
    let mut conn = Connection::new(100);
    conn.send(&frame(4, b"nope"));
    assert!(conn.closed);
}

struct ReferenceReader {
    buffer: Vec<u8>,
    next_length: Option<i64>,
    errors: Vec<String>,
    lengths: Vec<i64>,
}

impl ReferenceReader {
    fn new() -> Self {
        Self {
            buffer: Vec::new(),
            next_length: None,
            errors: Vec::new(),
            lengths: Vec::new(),
        }
    }

    fn header_end(&self) -> Option<usize> {
        let mut state = 0;
        for (at, byte) in self.buffer.iter().enumerate() {
            match *byte {
                b'\r' => {
                    state = match state {
                        0 => 1,
                        2 => 3,
                        _ => 0,
                    };
                }
                b'\n' => {
                    if state == 3 {
                        return Some(at + 1);
                    }
                    state = if state == 1 { 2 } else { 0 };
                }
                _ => state = 0,
            }
        }
        None
    }

    fn content_length(block: &[u8]) -> Result<i64, String> {
        let text: String = block.iter().map(|byte| (byte & 0x7f) as char).collect();
        let lines: Vec<&str> = text.split("\r\n").collect();
        let mut length = None;
        for line in &lines[..lines.len().saturating_sub(2)] {
            let colon = line
                .find(':')
                .ok_or_else(|| format!("no colon in {line:?}"))?;
            if line[..colon].eq_ignore_ascii_case("content-length") {
                length = Some(line[colon + 1..].trim().to_owned());
            }
        }
        let raw = length.ok_or_else(|| "no Content-Length".to_owned())?;
        let (sign, digits) = match raw.strip_prefix('-') {
            Some(rest) => (-1, rest),
            None => (1, raw.strip_prefix('+').unwrap_or(&raw)),
        };
        let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
        let value: i64 = digits
            .parse()
            .map_err(|_| format!("not a number: {raw:?}"))?;
        Ok(sign * value)
    }

    fn feed(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
        loop {
            let length = if let Some(length) = self.next_length {
                length
            } else {
                let Some(end) = self.header_end() else { return };
                let block: Vec<u8> = self.buffer.drain(..end).collect();
                match Self::content_length(&block) {
                    Ok(length) => {
                        self.next_length = Some(length);
                        self.lengths.push(length);
                        length
                    }
                    Err(error) => {
                        self.errors.push(error);
                        return;
                    }
                }
            };
            let Ok(wanted) = usize::try_from(length) else {
                return;
            };
            if self.buffer.len() < wanted {
                return;
            }
            self.buffer.drain(..wanted);
            self.next_length = None;
        }
    }
}

#[test]
fn never_lets_the_reader_see_a_header_it_would_read_differently() {
    let alphabet = [
        "\r",
        "\n",
        "\r\n",
        "Content-Length: 3",
        "Content-Length: 99999",
        "a",
        ":",
        " ",
    ];
    let max = 20;
    let mut seed: u64 = 7;
    let mut pick = || {
        seed = (seed * 1_103_515_245 + 12345) & 0x7fff_ffff;
        alphabet[usize::try_from(seed).unwrap() % alphabet.len()]
    };
    for round in 0..400 {
        let input: String = (0..12).map(|_| pick()).collect();
        let mut conn = Connection::new(max);
        let mut reader = ReferenceReader::new();
        for data in [input.as_bytes(), b"\r\n\r\n"] {
            conn.send(data);
            if !conn.closed {
                reader.feed(data);
            }
        }
        if !conn.closed {
            assert!(
                reader.errors.is_empty(),
                "round {round} {input:?}: {:?}",
                reader.errors
            );
            assert!(
                reader
                    .lengths
                    .iter()
                    .all(|length| (0..=i64::try_from(max).unwrap()).contains(length)),
                "round {round} {input:?}: {:?}",
                reader.lengths
            );
        }
    }
}
