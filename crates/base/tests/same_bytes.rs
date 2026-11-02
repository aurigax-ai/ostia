#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::same_bytes::same_bytes;

#[test]
fn is_true_for_equal_bytes() {
    assert!(same_bytes(b"token-123", b"token-123"));
    assert!(same_bytes(b"", b""));
}

#[test]
fn is_false_for_bytes_that_differ_in_one_position() {
    assert!(!same_bytes(b"token-123", b"token-124"));
    assert!(!same_bytes(b"\x00\x01", b"\x00\x02"));
}

#[test]
fn is_false_for_bytes_of_another_length() {
    assert!(!same_bytes(b"token", b"token-123"));
    assert!(!same_bytes(b"token-123", b"token"));
    assert!(!same_bytes(b"", b"x"));
}
