#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_terminal::pty_session::{
    CursorIssuer, PtySession, PtySessionOptions, Subscriber, SubscriberRole,
};
use parking_lot::Mutex;

type Sink = Arc<Mutex<Vec<String>>>;

fn sink() -> Sink {
    Arc::new(Mutex::new(Vec::new()))
}

fn seen(sink: &Sink) -> Vec<String> {
    sink.lock().clone()
}

fn sub(id: &str, role: SubscriberRole, into: &Sink) -> Subscriber {
    let into = Arc::clone(into);
    Subscriber::new(id, role, move |data, _cursor| {
        into.lock().push(data.to_owned());
    })
}

fn session(issuer: &CursorIssuer) -> PtySession {
    PtySession::new(issuer.clone(), PtySessionOptions::default())
}

fn counter() -> (Arc<Mutex<usize>>, impl Fn() + Send + Sync + 'static) {
    let count = Arc::new(Mutex::new(0usize));
    let bump = Arc::clone(&count);
    (count, move || *bump.lock() += 1)
}

#[test]
fn replays_history_to_a_new_subscriber_and_fans_out_live_output() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    s.push("boot\n");
    let a = sink();
    let res = s.add_subscriber(sub("a", SubscriberRole::Owner, &a), 0);
    assert!(!res.dropped);
    assert_eq!(seen(&a), ["boot\n"]);
    let b = sink();
    s.add_subscriber(sub("b", SubscriberRole::Observer, &b), 0);
    s.push("live");
    assert_eq!(seen(&a), ["boot\n", "live"]);
    assert_eq!(seen(&b), ["boot\n", "live"]);
}

#[test]
fn replays_a_new_pty_whole_and_dropped_to_a_cursor_from_an_earlier_one_even_below_its_end() {
    let issuer = CursorIssuer::default();
    let mut earlier = session(&issuer);
    earlier.push(&"x".repeat(3000));
    let stale = earlier.cursor() - 1000;
    let mut next = session(&issuer);
    next.push(&"y".repeat(5000));
    assert!(stale < next.cursor());
    let phone = sink();
    let res = next.add_subscriber(sub("phone", SubscriberRole::Observer, &phone), stale);
    assert!(res.dropped);
    assert_eq!(seen(&phone), ["y".repeat(5000)]);
}

#[test]
fn only_owners_may_write_observers_may_not() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    s.add_subscriber(sub("o", SubscriberRole::Owner, &sink()), 0);
    s.add_subscriber(sub("v", SubscriberRole::Observer, &sink()), 0);
    assert!(s.can_write("o"));
    assert!(!s.can_write("v"));
}

#[test]
fn fires_on_no_owners_only_when_the_last_owner_leaves_observers_do_not_hold_it_open() {
    let (count, on_no_owners) = counter();
    let issuer = CursorIssuer::default();
    let mut s = PtySession::new(
        issuer,
        PtySessionOptions::default().on_no_owners(on_no_owners),
    );
    s.add_subscriber(sub("o1", SubscriberRole::Owner, &sink()), 0);
    s.add_subscriber(sub("o2", SubscriberRole::Owner, &sink()), 0);
    s.add_subscriber(sub("v", SubscriberRole::Observer, &sink()), 0);
    s.remove_subscriber("o1");
    assert_eq!(*count.lock(), 0);
    s.remove_subscriber("v");
    assert_eq!(*count.lock(), 0);
    s.remove_subscriber("o2");
    assert_eq!(*count.lock(), 1);
}

#[test]
fn notifies_on_exit_and_forwards_exit_to_no_one_after_end() {
    let codes = Arc::new(Mutex::new(Vec::new()));
    let seen_codes = Arc::clone(&codes);
    let issuer = CursorIssuer::default();
    let s = PtySession::new(
        issuer,
        PtySessionOptions::default().on_exit(move |code| seen_codes.lock().push(code)),
    );
    s.exit(0);
    assert_eq!(*codes.lock(), [0]);
}

#[test]
fn since_0_returns_buffered_data_as_a_string_without_invoking_any_subscriber_send() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    s.push("boot\n");
    let into = sink();
    s.add_subscriber(sub("a", SubscriberRole::Owner, &into), 0);
    into.lock().clear();
    let result = s.since(0);
    assert_eq!(result.data, "boot\n");
    assert!(!result.dropped);
    assert!(seen(&into).is_empty());
}

#[test]
fn add_live_subscriber_receives_future_pushes_but_not_past_history() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    s.push("old");
    let into = sink();
    s.add_live_subscriber(sub("a", SubscriberRole::Owner, &into));
    assert!(seen(&into).is_empty());
    s.push("new");
    assert_eq!(seen(&into), ["new"]);
}

#[test]
fn closes_a_subscriber_when_it_is_removed_or_replaced_by_a_re_attach_with_the_same_id() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    let closed = sink();
    let first_closed = Arc::clone(&closed);
    let second_closed = Arc::clone(&closed);
    let first = sub("w", SubscriberRole::Owner, &sink())
        .with_close(move || first_closed.lock().push("first".to_owned()));
    let second = sub("w", SubscriberRole::Owner, &sink())
        .with_close(move || second_closed.lock().push("second".to_owned()));
    s.add_live_subscriber(first);
    s.add_live_subscriber(second);
    assert_eq!(seen(&closed), ["first"]);
    s.remove_subscriber("w");
    assert_eq!(seen(&closed), ["first", "second"]);
}

#[test]
fn flushes_every_subscriber_before_reporting_the_exit() {
    let order = sink();
    let exit_order = Arc::clone(&order);
    let flush_order = Arc::clone(&order);
    let issuer = CursorIssuer::default();
    let mut s = PtySession::new(
        issuer,
        PtySessionOptions::default().on_exit(move |_| exit_order.lock().push("exit".to_owned())),
    );
    s.add_live_subscriber(
        sub("w", SubscriberRole::Owner, &sink())
            .with_flush(move || flush_order.lock().push("flush".to_owned())),
    );
    s.exit(0);
    assert_eq!(seen(&order), ["flush", "exit"]);
}

#[test]
fn passes_the_ring_end_cursor_with_every_pushed_chunk() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    let cursors = Arc::new(Mutex::new(Vec::new()));
    let into = Arc::clone(&cursors);
    s.add_live_subscriber(Subscriber::new(
        "a",
        SubscriberRole::Owner,
        move |_, cursor| {
            into.lock().push(cursor);
        },
    ));
    s.push("abc");
    s.push("de");
    assert_eq!(*cursors.lock(), [3, 5]);
    assert_eq!(s.cursor(), 5);
}

#[test]
fn passes_the_end_cursor_with_the_replay_to_a_new_subscriber() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    s.push("abc");
    let cursors = Arc::new(Mutex::new(Vec::new()));
    let into = Arc::clone(&cursors);
    let res = s.add_subscriber(
        Subscriber::new("a", SubscriberRole::Observer, move |_, cursor| {
            into.lock().push(cursor);
        }),
        0,
    );
    assert_eq!(res.cursor, 3);
    assert_eq!(*cursors.lock(), [3]);
}

#[test]
fn sends_nothing_to_a_new_subscriber_whose_cursor_is_already_at_the_end() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    s.push("abc");
    let into = sink();
    let res = s.add_subscriber(sub("a", SubscriberRole::Owner, &into), s.cursor());
    assert!(!res.dropped);
    assert_eq!(res.cursor, 3);
    assert!(seen(&into).is_empty());
}

#[test]
fn covers_only_the_named_subscriber_and_ignores_an_unknown_id() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    let log = sink();
    let a_log = Arc::clone(&log);
    let b_log = Arc::clone(&log);
    s.add_live_subscriber(
        sub("a", SubscriberRole::Owner, &sink())
            .with_cover(move |covered| a_log.lock().push(format!("a:{covered}"))),
    );
    s.add_live_subscriber(
        sub("b", SubscriberRole::Observer, &sink())
            .with_cover(move |covered| b_log.lock().push(format!("b:{covered}"))),
    );
    s.cover("a", true);
    s.cover("b", false);
    s.cover("missing", true);
    assert_eq!(seen(&log), ["a:true", "b:false"]);
}

#[test]
fn counts_owners_and_not_observers() {
    let issuer = CursorIssuer::default();
    let mut s = session(&issuer);
    assert_eq!(s.owner_count(), 0);
    s.add_live_subscriber(sub("o1", SubscriberRole::Owner, &sink()));
    s.add_live_subscriber(sub("o2", SubscriberRole::Owner, &sink()));
    s.add_live_subscriber(sub("v", SubscriberRole::Observer, &sink()));
    assert_eq!(s.owner_count(), 2);
    s.remove_subscriber("o1");
    assert_eq!(s.owner_count(), 1);
}

#[test]
fn removing_an_unknown_id_closes_nothing_and_fires_no_on_no_owners() {
    let (count, on_no_owners) = counter();
    let issuer = CursorIssuer::default();
    let mut s = PtySession::new(
        issuer,
        PtySessionOptions::default().on_no_owners(on_no_owners),
    );
    s.remove_subscriber("missing");
    assert_eq!(*count.lock(), 0);
}

#[test]
fn cannot_write_for_an_unknown_id() {
    let issuer = CursorIssuer::default();
    let s = session(&issuer);
    assert!(!s.can_write("missing"));
}

#[test]
fn a_replaced_owner_does_not_fire_on_no_owners() {
    let (count, on_no_owners) = counter();
    let issuer = CursorIssuer::default();
    let mut s = PtySession::new(
        issuer,
        PtySessionOptions::default().on_no_owners(on_no_owners),
    );
    s.add_live_subscriber(sub("w", SubscriberRole::Owner, &sink()));
    s.add_live_subscriber(sub("w", SubscriberRole::Owner, &sink()));
    assert_eq!(*count.lock(), 0);
    assert_eq!(s.owner_count(), 1);
}

#[test]
fn a_session_with_a_small_cap_drops_old_output_and_reports_it_dropped() {
    let issuer = CursorIssuer::default();
    let mut s = PtySession::new(issuer, PtySessionOptions::default().cap_bytes(100));
    s.push(&"a".repeat(80));
    let early = s.cursor();
    s.push(&"b".repeat(80));
    let result = s.since(early - 70);
    assert!(result.dropped);
}

#[test]
fn issues_a_later_session_a_cursor_past_every_earlier_one() {
    let issuer = CursorIssuer::default();
    let mut first = session(&issuer);
    first.push(&"x".repeat(10));
    let second = session(&issuer);
    assert!(second.cursor() >= first.cursor());
}
