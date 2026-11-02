#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::RefCell;
use std::rc::Rc;

use ostia_model::terminal::pty_ack::{PTY_ACK_CHARS, PtyAcker};

fn recording() -> (PtyAcker<impl FnMut(i64)>, Rc<RefCell<Vec<i64>>>) {
    let acks = Rc::new(RefCell::new(Vec::new()));
    let sink = Rc::clone(&acks);
    (
        PtyAcker::new(move |chars| sink.borrow_mut().push(chars)),
        acks,
    )
}

#[test]
fn acknowledges_written_characters_in_batches_of_at_least_pty_ack_chars() {
    let (mut acker, acks) = recording();
    acker.written(PTY_ACK_CHARS - 1);
    assert_eq!(*acks.borrow(), Vec::<i64>::new());
    acker.written(3);
    assert_eq!(*acks.borrow(), vec![PTY_ACK_CHARS + 2]);
    acker.written(PTY_ACK_CHARS * 3);
    assert_eq!(*acks.borrow(), vec![PTY_ACK_CHARS + 2, PTY_ACK_CHARS * 3]);
}

#[test]
fn sends_at_exactly_the_threshold_and_starts_a_new_batch_after() {
    let (mut acker, acks) = recording();
    acker.written(PTY_ACK_CHARS);
    assert_eq!(*acks.borrow(), vec![PTY_ACK_CHARS]);
    acker.written(1);
    assert_eq!(*acks.borrow(), vec![PTY_ACK_CHARS]);
    acker.written(PTY_ACK_CHARS - 1);
    assert_eq!(*acks.borrow(), vec![PTY_ACK_CHARS, PTY_ACK_CHARS]);
}

#[test]
fn counts_small_writes_until_they_add_up_to_a_batch() {
    let (mut acker, acks) = recording();
    for _ in 0..PTY_ACK_CHARS {
        acker.written(1);
    }
    assert_eq!(*acks.borrow(), vec![PTY_ACK_CHARS]);
}

#[test]
fn a_write_of_zero_sends_nothing() {
    let (mut acker, acks) = recording();
    acker.written(0);
    assert!(acks.borrow().is_empty());
}
