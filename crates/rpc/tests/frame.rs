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
