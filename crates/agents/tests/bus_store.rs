#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use ostia_agents::bus_store::{
    BusKind, BusObservation, BusPhase, BusStore, HISTORY_MS, HISTORY_PER_SENDER, INBOX_MAX,
    LEASE_MS, MAIL_TTL_MS, Mail, MailDraft, MailJournal, MailKind, MailPending, MailPick,
    MailState, MailVia, MailViewState, ReceiveOutcome, RemoteMail,
};
use ostia_base::clock::Clock;
use serde_json::{Value, json};
use tempfile::TempDir;

const START: i64 = 1_792_317_600_000;

#[derive(Clone)]
struct Time(Arc<AtomicI64>);

impl Time {
    fn at(ms: i64) -> Self {
        Self(Arc::new(AtomicI64::new(ms)))
    }

    fn clock(&self) -> Clock {
        let ms = Arc::clone(&self.0);
        Arc::new(move || ms.load(Ordering::SeqCst))
    }

    fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }

    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
struct RecordedJournal {
    mail: Mutex<Vec<(String, i64, String)>>,
    lease_timeouts: Mutex<Vec<(i64, String)>>,
}

impl MailJournal for RecordedJournal {
    fn mail(&self, reason: &str, age_ms: i64, to: &str) {
        self.mail
            .lock()
            .unwrap()
            .push((reason.to_owned(), age_ms, to.to_owned()));
    }

    fn lease_timeout(&self, age_ms: i64, to: &str) {
        self.lease_timeouts
            .lock()
            .unwrap()
            .push((age_ms, to.to_owned()));
    }
}

struct Rig {
    dir: TempDir,
    time: Time,
    store: BusStore,
    observed: Arc<Mutex<Vec<BusObservation>>>,
    journal: Arc<RecordedJournal>,
}

impl Rig {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let time = Time::at(START);
        let store = BusStore::new(dir.path().join("ostia").join("bus.json"), time.clock());
        let observed = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&observed);
        store.set_observer(Some(Arc::new(move |observation: BusObservation| {
            sink.lock().unwrap().push(observation);
        })));
        let journal = Arc::new(RecordedJournal::default());
        store.set_journal(Some(journal.clone()));
        Self {
            dir,
            time,
            store,
            observed,
            journal,
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.path().join("ostia").join("bus.json")
    }

    fn send(&self, text: &str, to: &str, from: &str) -> Mail {
        self.store.enqueue(MailDraft::new(from, to, text))
    }

    fn ab(&self, text: &str) -> Mail {
        self.send(text, "b", "a")
    }

    fn deliver(&self, to: &str, via: MailVia, pick: impl Fn(&Mail) -> bool) -> Vec<Mail> {
        match self.store.lease_mail(to, via, pick) {
            Some(handed) => {
                self.store.ack_mail(to, &handed.lease);
                handed.messages
            }
            None => Vec::new(),
        }
    }

    fn observations(&self) -> Vec<(String, BusPhase)> {
        self.observed
            .lock()
            .unwrap()
            .iter()
            .map(|observation| (observation.id.clone(), observation.phase))
            .collect()
    }
}

fn all(_: &Mail) -> bool {
    true
}

fn texts(mails: &[Mail]) -> Vec<String> {
    mails
        .iter()
        .map(|mail| mail.text.clone().unwrap_or_default())
        .collect()
}

fn ids(mails: &[Mail]) -> Vec<String> {
    mails.iter().map(|mail| mail.id.clone()).collect()
}

fn pick_from(sender: &'static str) -> MailPick {
    Arc::new(move |mail: &Mail| mail.from == sender)
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

async fn settle() {
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
}

fn drained<T>(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<T>) -> Vec<T> {
    let mut seen = Vec::new();
    while let Ok(item) = receiver.try_recv() {
        seen.push(item);
    }
    seen
}

#[tokio::test]
async fn starts_queued_is_delivered_once_by_take_and_drops_its_text_after() {
    let rig = Rig::new();
    let mail = rig.ab("build is green");
    let queued = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(queued.state, MailState::Queued);
    assert_eq!(queued.text.as_deref(), Some("build is green"));

    let first = rig.deliver("b", MailVia::Read, all);
    assert_eq!(texts(&first), ["build is green"]);
    assert!(rig.deliver("b", MailVia::Read, all).is_empty());

    let after = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(after.state, MailState::Delivered);
    assert_eq!(after.via, Some(MailVia::Read));
    assert_eq!(after.preview, "build is green");
    assert!(after.text.is_none());
    assert!(rig.store.inbox_of("b").is_empty());
}

#[tokio::test]
async fn hands_each_message_to_exactly_one_of_two_takes_in_a_row() {
    let rig = Rig::new();
    for i in 0..5 {
        rig.ab(&format!("m{i}"));
    }
    let one = rig.deliver("b", MailVia::Prompt, all);
    let two = rig.deliver("b", MailVia::Read, all);
    assert_eq!(one.len(), 5);
    assert!(two.is_empty());
    let mut unique = ids(&one);
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 5);
}

#[tokio::test]
async fn takes_only_what_the_picker_allows_and_only_for_that_receiver() {
    let rig = Rig::new();
    let keep = rig.ab("keep");
    rig.send("other pane", "c", "a");
    let taken = rig.deliver("b", MailVia::Read, |mail| mail.id != keep.id);
    assert!(taken.is_empty());
    assert_eq!(
        rig.store.get_mail(&keep.id).unwrap().state,
        MailState::Queued
    );
    assert_eq!(rig.store.inbox_of("c").len(), 1);
}

#[tokio::test]
async fn keeps_the_order_messages_were_sent_in() {
    let rig = Rig::new();
    rig.ab("one");
    rig.ab("two");
    rig.ab("three");
    assert_eq!(
        texts(&rig.deliver("b", MailVia::Read, all)),
        ["one", "two", "three"]
    );
}

#[tokio::test]
async fn lists_a_sender_only_its_own_non_quiet_mail_newest_last() {
    let rig = Rig::new();
    rig.ab("mine");
    rig.send("theirs", "a", "b");
    rig.store.enqueue(MailDraft {
        quiet: true,
        ..MailDraft::new("a", "b", "report")
    });
    let previews: Vec<String> = rig
        .store
        .sent_by("a")
        .into_iter()
        .map(|mail| mail.preview)
        .collect();
    assert_eq!(previews, ["mine"]);
}

#[tokio::test]
async fn moves_leased_mail_to_delivered_on_ack_once_only_for_the_receiver() {
    let rig = Rig::new();
    let mail = rig.ab("hi");
    let lease = rig
        .store
        .lease_mail("b", MailVia::Prompt, all)
        .expect("a lease");
    assert_eq!(ids(&lease.messages), [mail.id.clone()]);
    assert_eq!(
        rig.store.get_mail(&mail.id).unwrap().state,
        MailState::Leased
    );
    assert!(rig.deliver("b", MailVia::Read, all).is_empty());
    assert_eq!(rig.store.inbox_of("b").len(), 1);

    assert!(rig.store.ack_mail("c", &lease.lease).is_empty());
    assert!(rig.store.ack_mail("b", "not-a-lease").is_empty());
    assert_eq!(
        rig.store.ack_mail("b", &lease.lease),
        [mail.id.clone()].to_vec()
    );
    assert!(rig.store.ack_mail("b", &lease.lease).is_empty());
    let after = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(after.state, MailState::Delivered);
    assert_eq!(after.via, Some(MailVia::Prompt));
}

#[tokio::test]
async fn returns_an_unacknowledged_lease_to_queued_after_the_timeout_so_a_later_take_gets_it() {
    let rig = Rig::new();
    let mail = rig.ab("hi");
    let lease = rig.store.lease_mail("b", MailVia::Start, all).unwrap();
    rig.time.advance(LEASE_MS + 1);
    assert_eq!(
        rig.store.get_mail(&mail.id).unwrap().state,
        MailState::Queued
    );
    assert!(rig.store.ack_mail("b", &lease.lease).is_empty());
    assert_eq!(ids(&rig.deliver("b", MailVia::Read, all)), [mail.id]);
}

#[tokio::test]
async fn leases_nothing_when_there_is_nothing_queued() {
    let rig = Rig::new();
    assert!(rig.store.lease_mail("b", MailVia::Prompt, all).is_none());
}

#[tokio::test]
async fn fails_queued_mail_after_24_hours_with_the_last_pending_reason() {
    let rig = Rig::new();
    let mail = rig.ab("hi");
    rig.store.set_pending(&mail.id, MailPending::Hibernated);
    rig.time.advance(MAIL_TTL_MS - 1000);
    assert_eq!(
        rig.store.get_mail(&mail.id).unwrap().state,
        MailState::Queued
    );
    rig.time.advance(2000);
    let failed = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(failed.state, MailState::Failed);
    assert_eq!(failed.reason.as_deref(), Some("expired:hibernated"));
    assert!(rig.deliver("b", MailVia::Read, all).is_empty());
}

#[tokio::test]
async fn names_an_expiry_without_a_known_reason_as_queued() {
    let rig = Rig::new();
    let mail = rig.ab("hi");
    rig.time.advance(MAIL_TTL_MS + 1);
    assert_eq!(
        rig.store.get_mail(&mail.id).unwrap().reason.as_deref(),
        Some("expired:queued")
    );
}

#[tokio::test]
async fn does_not_expire_mail_that_was_delivered() {
    let rig = Rig::new();
    let mail = rig.ab("hi");
    rig.deliver("b", MailVia::Read, all);
    rig.time.advance(MAIL_TTL_MS + 1);
    assert_eq!(
        rig.store.get_mail(&mail.id).unwrap().state,
        MailState::Delivered
    );
}

#[tokio::test]
async fn fails_queued_and_leased_mail_for_a_closed_pane_at_once_and_leaves_others_alone() {
    let rig = Rig::new();
    let queued = rig.ab("one");
    let leased = rig.ab("two");
    rig.store
        .lease_mail("b", MailVia::Prompt, |mail| mail.id == leased.id);
    let delivered = rig.ab("three");
    rig.deliver("b", MailVia::Read, |mail| mail.id == delivered.id);
    let other = rig.send("four", "c", "a");

    rig.store.fail_pane_mail("b");

    for id in [&queued.id, &leased.id] {
        let mail = rig.store.get_mail(id).unwrap();
        assert_eq!(mail.state, MailState::Failed);
        assert_eq!(mail.reason.as_deref(), Some("pane-closed"));
    }
    assert_eq!(
        rig.store.get_mail(&delivered.id).unwrap().state,
        MailState::Delivered
    );
    assert_eq!(
        rig.store.get_mail(&other.id).unwrap().state,
        MailState::Queued
    );
}

#[tokio::test]
async fn drops_history_after_seven_days_and_past_500_per_sender() {
    let rig = Rig::new();
    let old = rig.ab("old");
    rig.deliver("b", MailVia::Read, all);
    rig.time.advance(HISTORY_MS + 1000);
    rig.send("fresh", "b", "z");
    assert!(rig.store.get_mail(&old.id).is_none());

    let first = rig.send("m0", "d", "busy");
    rig.deliver("d", MailVia::Read, all);
    for i in 1..=HISTORY_PER_SENDER {
        rig.send(&format!("m{i}"), "d", "busy");
        rig.deliver("d", MailVia::Read, all);
    }
    let last = rig.send("last", "d", "busy");
    assert!(rig.store.get_mail(&first.id).is_none());
    assert!(rig.store.get_mail(&last.id).is_some());
}

#[tokio::test]
async fn shows_undelivered_mail_as_queued_leased_mail_too_and_leaves_out_delivered_and_quiet_mail()
{
    let rig = Rig::new();
    let waiting = rig.ab("wait");
    let leased = rig.ab("leased");
    rig.store
        .lease_mail("b", MailVia::Prompt, |mail| mail.id == leased.id);
    let read = rig.ab("read");
    rig.deliver("b", MailVia::Read, |mail| mail.id == read.id);
    rig.store.enqueue(MailDraft {
        quiet: true,
        ..MailDraft::new("a", "b", "report")
    });
    rig.store.set_pending(&waiting.id, MailPending::Hibernated);
    let views: Vec<_> = rig
        .store
        .mail_views()
        .into_iter()
        .map(|view| (view.id, view.state, view.pending))
        .collect();
    assert_eq!(
        views,
        [
            (
                waiting.id,
                MailViewState::Queued,
                Some(MailPending::Hibernated)
            ),
            (leased.id, MailViewState::Queued, None),
        ]
    );
}

#[tokio::test]
async fn shows_a_failed_message_with_its_reason_until_it_is_dismissed_at_most_five_per_pane() {
    let rig = Rig::new();
    for i in 0..7 {
        rig.ab(&format!("m{i}"));
    }
    rig.store.fail_pane_mail("b");
    let shown = rig.store.mail_views();
    assert_eq!(shown.len(), 5);
    assert!(
        shown.iter().all(|view| view.state == MailViewState::Failed
            && view.reason.as_deref() == Some("pane-closed"))
    );
    rig.store.dismiss_failed("c");
    assert_eq!(rig.store.mail_views().len(), 5);
    rig.store.dismiss_failed("b");
    assert!(rig.store.mail_views().is_empty());
}

#[tokio::test]
async fn keeps_a_dismissal_across_a_reload() {
    let rig = Rig::new();
    rig.ab("hi");
    rig.store.fail_pane_mail("b");
    rig.store.dismiss_failed("b");
    rig.store.flush().await;
    rig.store.reset().await;
    assert!(rig.store.mail_views().is_empty());
}

#[tokio::test]
async fn tells_a_listener_once_per_change_however_many_mutations_the_change_made() {
    let rig = Rig::new();
    let mut changes = rig.store.on_change();
    rig.ab("one");
    rig.ab("two");
    rig.deliver("b", MailVia::Read, all);
    settle().await;
    assert_eq!(drained(&mut changes).len(), 1);
    rig.ab("three");
    settle().await;
    assert_eq!(drained(&mut changes).len(), 1);
    drop(changes);
    rig.ab("four");
    settle().await;
}

#[tokio::test]
async fn keeps_one_queued_event_per_watched_pane_and_subscriber_with_every_line_since_and_starts_a_new_one_after_a_take()
 {
    let rig = Rig::new();
    rig.store.post_event("w", "b", "first line");
    rig.store.post_event("w", "b", "second line");
    rig.store.post_event("other", "b", "from another pane");
    let queued = rig.store.inbox_of("b");
    let rows: Vec<_> = queued
        .iter()
        .map(|mail| (mail.kind, mail.from.clone(), mail.text.clone().unwrap()))
        .collect();
    assert_eq!(
        rows,
        [
            (
                MailKind::Event,
                "w".to_owned(),
                "first line\nsecond line".to_owned()
            ),
            (
                MailKind::Event,
                "other".to_owned(),
                "from another pane".to_owned()
            ),
        ]
    );
    rig.deliver("b", MailVia::Read, all);
    rig.store.post_event("w", "b", "third line");
    assert_eq!(texts(&rig.store.inbox_of("b")), ["third line"]);
}

#[tokio::test]
async fn keeps_only_the_newest_lines_of_a_long_run_of_coalesced_events_and_shows_the_newest_as_the_preview()
 {
    let rig = Rig::new();
    for i in 1..=30 {
        rig.store.post_event("w", "b", &format!("line {i}"));
    }
    let inbox = rig.store.inbox_of("b");
    let event = &inbox[0];
    let text = event.text.clone().unwrap();
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(lines.len(), 20);
    assert_eq!(lines[0], "line 11");
    assert_eq!(lines.last().copied(), Some("line 30"));
    assert_eq!(event.preview, "line 30");
}

#[tokio::test]
async fn leaves_events_out_of_the_senders_list_the_senders_counts_and_the_extension_events() {
    let rig = Rig::new();
    rig.store.post_event("w", "b", "status");
    assert!(rig.store.sent_by("w").is_empty());
    let sender = rig.store.mail_counts("w");
    assert_eq!((sender.sent_queued, sender.sent_failed), (0, 0));
    assert_eq!(rig.store.mail_counts("b").queued, 1);
    assert!(rig.observations().is_empty());
    let states: Vec<_> = rig
        .store
        .mail_views()
        .into_iter()
        .map(|view| view.state)
        .collect();
    assert_eq!(states, [MailViewState::Queued]);
}

#[tokio::test]
async fn fails_an_event_with_the_rest_of_the_panes_mail_and_delivers_it_to_a_parked_waiter() {
    let rig = Rig::new();
    let mut waiter = rig.store.add_waiter("b", None);
    rig.store.post_event("w", "b", "status");
    let handed = waiter.try_recv().expect("handed");
    let kinds: Vec<_> = handed.messages.iter().map(|mail| mail.kind).collect();
    assert_eq!(kinds, [MailKind::Event]);
    rig.store.ack_mail("b", &handed.lease);
    rig.store.post_event("w", "c", "status");
    rig.store.fail_pane_mail("c");
    let states: Vec<_> = rig
        .store
        .mail_views()
        .into_iter()
        .map(|view| view.state)
        .collect();
    assert_eq!(states, [MailViewState::Failed]);
}

#[tokio::test]
async fn stores_a_watch_once_per_pair_lists_it_by_subscriber_and_by_watched_pane_and_ends_it_on_request()
 {
    let rig = Rig::new();
    rig.store.watch_pane("boss", "w1", &["done"]);
    rig.store.watch_pane("boss", "w1", &["error"]);
    rig.store.watch_pane("boss", "w2", &["done"]);
    rig.store.watch_pane("other", "w1", &["done"]);
    let watches: Vec<_> = rig
        .store
        .watches_of("boss")
        .into_iter()
        .map(|watch| (watch.watched, watch.until))
        .collect();
    assert_eq!(
        watches,
        [
            ("w1".to_owned(), vec!["error".to_owned()]),
            ("w2".to_owned(), vec!["done".to_owned()]),
        ]
    );
    let watchers: Vec<_> = rig
        .store
        .watchers_of("w1")
        .into_iter()
        .map(|watch| watch.subscriber)
        .collect();
    assert_eq!(watchers, ["boss", "other"]);
    rig.store.unwatch_panes("boss", Some(&["w1"]));
    let left: Vec<_> = rig
        .store
        .watches_of("boss")
        .into_iter()
        .map(|watch| watch.watched)
        .collect();
    assert_eq!(left, ["w2"]);
    rig.store.unwatch_panes("boss", None);
    assert!(rig.store.watches_of("boss").is_empty());
}

#[tokio::test]
async fn drops_every_watch_a_closed_pane_took_part_in_whichever_side_it_was_on() {
    let rig = Rig::new();
    rig.store.watch_pane("boss", "w1", &["done"]);
    rig.store.watch_pane("w1", "w2", &["done"]);
    rig.store.watch_pane("other", "w3", &["done"]);
    rig.store.drop_watches_of("w1");
    assert!(rig.store.watches_of("boss").is_empty());
    assert!(rig.store.watches_of("w1").is_empty());
    assert_eq!(rig.store.watches_of("other").len(), 1);
}

#[tokio::test]
async fn keeps_watches_across_a_reload() {
    let rig = Rig::new();
    rig.store.watch_pane("boss", "w1", &["done", "command"]);
    rig.store.flush().await;
    rig.store.reset().await;
    let watches = rig.store.watches_of("boss");
    assert_eq!(watches.len(), 1);
    assert_eq!(watches[0].subscriber, "boss");
    assert_eq!(watches[0].watched, "w1");
    assert_eq!(watches[0].until, ["done", "command"]);
}

#[tokio::test]
async fn reports_an_expiry_and_a_closed_pane_by_reason_and_age_and_never_the_text_or_ids() {
    let rig = Rig::new();
    let lost = rig.ab("secret text");
    rig.store.set_pending(&lost.id, MailPending::Hibernated);
    rig.time.advance(MAIL_TTL_MS + 1000);
    rig.store.get_mail(&lost.id);
    rig.send("another secret", "c", "a");
    rig.time.advance(5000);
    rig.store.fail_pane_mail("c");
    let calls = rig.journal.mail.lock().unwrap().clone();
    assert_eq!(
        calls,
        [
            (
                "expired:hibernated".to_owned(),
                MAIL_TTL_MS + 1000,
                "b".to_owned()
            ),
            ("pane-closed".to_owned(), 5000, "c".to_owned()),
        ]
    );
    assert!(!format!("{calls:?}").contains("secret"));
}

#[tokio::test]
async fn reports_a_lease_that_timed_out_with_the_age_of_the_message() {
    let rig = Rig::new();
    rig.ab("hi");
    rig.store.lease_mail("b", MailVia::Prompt, all);
    rig.time.advance(LEASE_MS + 1);
    rig.store.inbox_of("b");
    assert_eq!(
        *rig.journal.lease_timeouts.lock().unwrap(),
        [(LEASE_MS + 1, "b".to_owned())]
    );
}

#[tokio::test]
async fn is_full_at_200_undelivered_messages_and_delivering_frees_room() {
    let rig = Rig::new();
    for i in 0..INBOX_MAX {
        rig.ab(&format!("m{i}"));
    }
    assert!(rig.store.inbox_full("b"));
    assert!(!rig.store.inbox_full("c"));
    rig.deliver("b", MailVia::Read, |mail| {
        mail.text.as_deref() == Some("m0")
    });
    assert!(!rig.store.inbox_full("b"));
}

#[tokio::test]
async fn reports_queued_then_delivered_or_failed_once_each_and_never_for_a_quiet_message() {
    let rig = Rig::new();
    let a = rig.ab("x");
    let b = rig.ab("y");
    rig.store.enqueue(MailDraft {
        quiet: true,
        ..MailDraft::new("a", "b", "q")
    });
    rig.deliver("b", MailVia::Read, |mail| mail.id == a.id);
    rig.store.fail_pane_mail("b");
    assert_eq!(
        rig.observations(),
        [
            (a.id.clone(), BusPhase::Queued),
            (b.id.clone(), BusPhase::Queued),
            (a.id, BusPhase::Delivered),
            (b.id, BusPhase::Failed),
        ]
    );
    assert!(!format!("{:?}", rig.observed.lock().unwrap()).contains("\"x\""));
}

#[tokio::test]
async fn leases_mail_straight_to_a_parked_waiter_and_delivers_it_as_read_on_ack() {
    let rig = Rig::new();
    let mut waiter = rig.store.add_waiter("b", None);
    let mail = rig.ab("wake up");
    let handed = waiter.try_recv().expect("handed once");
    assert!(waiter.try_recv().is_none());
    assert_eq!(texts(&handed.messages), ["wake up"]);
    let leased = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(leased.state, MailState::Leased);
    assert_eq!(leased.via, Some(MailVia::Read));
    rig.store.ack_mail("b", &handed.lease);
    let delivered = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(delivered.state, MailState::Delivered);
    assert_eq!(delivered.via, Some(MailVia::Read));
}

#[tokio::test]
async fn queues_mail_handed_to_a_waiter_again_when_its_lease_is_released_unacknowledged() {
    let rig = Rig::new();
    let mut waiter = rig.store.add_waiter("b", None);
    let mail = rig.ab("do not lose me");
    let handed = waiter.try_recv().unwrap();
    rig.store.release_mail("b", &handed.lease);
    assert_eq!(
        rig.store.get_mail(&mail.id).unwrap().state,
        MailState::Queued
    );
}

#[tokio::test]
async fn hands_a_message_to_only_the_first_of_two_parked_waits_of_one_pane_and_keeps_the_other_parked()
 {
    let rig = Rig::new();
    let mut first = rig.store.add_waiter("b", None);
    let mut second = rig.store.add_waiter("b", None);
    rig.ab("only once");
    assert!(first.try_recv().is_some());
    assert!(second.try_recv().is_none());
    let next = rig.ab("for the second");
    let handed = second.try_recv().expect("second handed");
    assert_eq!(ids(&handed.messages), [next.id]);
}

#[tokio::test]
async fn hands_a_waiter_that_picks_only_the_messages_it_picks_and_leaves_the_rest_queued() {
    let rig = Rig::new();
    let mut waiter = rig.store.add_waiter("b", Some(pick_from("c")));
    let other = rig.ab("from a");
    assert!(waiter.try_recv().is_none());
    assert_eq!(
        rig.store.get_mail(&other.id).unwrap().state,
        MailState::Queued
    );
    let wanted = rig.send("from c", "b", "c");
    let handed = waiter.try_recv().expect("handed");
    assert_eq!(ids(&handed.messages), [wanted.id]);
}

#[tokio::test]
async fn hands_a_message_to_the_waiter_that_picks_it_before_a_plain_waiter_parked_earlier() {
    let rig = Rig::new();
    let mut plain = rig.store.add_waiter("b", None);
    let mut picky = rig.store.add_waiter("b", Some(pick_from("c")));
    rig.send("from c", "b", "c");
    assert!(picky.try_recv().is_some());
    assert!(plain.try_recv().is_none());
    rig.ab("from a");
    assert!(plain.try_recv().is_some());
}

#[tokio::test]
async fn tells_a_message_sent_after_another_by_its_place_in_the_store_not_its_clock() {
    let rig = Rig::new();
    let before = rig.ab("before");
    let question = rig.ab("question");
    let after = rig.ab("after");
    let later = rig.store.sent_after(&question.id, &question.ts);
    assert!(!later(&before));
    assert!(later(&after));
    assert!(rig.store.sent_after("gone", &question.ts)(&after));
}

#[tokio::test]
async fn queues_again_once_a_waiter_is_unregistered() {
    let rig = Rig::new();
    let mut waiter = rig.store.add_waiter("b", None);
    waiter.cancel();
    assert_eq!(rig.ab("anyone?").state, MailState::Queued);
    assert!(waiter.try_recv().is_none());
}

#[tokio::test]
async fn writes_the_store_0600_in_a_0700_folder_and_a_reload_keeps_queued_mail() {
    let rig = Rig::new();
    let mail = rig.ab("keep me");
    rig.store.flush().await;
    let file_mode = fs::metadata(rig.file()).unwrap().permissions().mode() & 0o777;
    let dir_mode = fs::metadata(rig.file().parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(file_mode, 0o600);
    assert_eq!(dir_mode, 0o700);

    rig.store.reset().await;
    let inbox = rig.store.inbox_of("b");
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].id, mail.id);
    assert_eq!(inbox[0].text.as_deref(), Some("keep me"));
}

#[tokio::test]
async fn keeps_only_the_preview_of_delivered_mail_on_disk_not_the_text() {
    let rig = Rig::new();
    rig.ab("first line\nsecond line sk-abc");
    rig.deliver("b", MailVia::Read, all);
    rig.store.flush().await;
    let written = fs::read_to_string(rig.file()).unwrap();
    assert!(written.contains("first line"));
    assert!(!written.contains("sk-abc"));
}

#[tokio::test]
async fn reads_a_store_written_by_an_older_version_as_empty() {
    let rig = Rig::new();
    fs::create_dir_all(rig.file().parent().unwrap()).unwrap();
    fs::write(
        rig.file(),
        json!({"inboxes": {"b": [{"id": "x", "text": "old"}]}, "sent": []}).to_string(),
    )
    .unwrap();
    rig.store.reset().await;
    assert!(rig.store.inbox_of("b").is_empty());
}

#[tokio::test]
async fn rem_s1_writes_the_mail_to_disk_before_answering_stored_and_stores_nothing_when_the_write_fails()
 {
    let rig = Rig::new();
    let good = rig.dir.path().join("receive-good.json");
    rig.store.set_path(good.clone());
    let blocker = rig.dir.path().join("not-a-folder");
    fs::write(&blocker, "").unwrap();
    rig.store.set_path(blocker.join("bus.json"));
    let draft = RemoteMail {
        id: "h:1".to_owned(),
        origin: "remote:h".to_owned(),
        from: "remote:h:0123abcd".to_owned(),
        to: "p1".to_owned(),
        text: "once".to_owned(),
    };
    assert!(rig.store.receive(draft.clone()).await.is_err());
    assert!(rig.store.inbox_of("p1").is_empty());
    rig.store.set_path(good.clone());
    assert_eq!(
        rig.store.receive(draft.clone()).await.unwrap(),
        ReceiveOutcome::Stored
    );
    assert_eq!(
        rig.store.receive(draft).await.unwrap(),
        ReceiveOutcome::Stored
    );
    assert_eq!(rig.store.inbox_of("p1").len(), 1);
    let written: Value = serde_json::from_str(&fs::read_to_string(good).unwrap()).unwrap();
    let written_ids: Vec<&str> = written["mail"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|mail| mail["id"].as_str())
        .collect();
    assert!(written_ids.contains(&"h:1"));
}

#[tokio::test]
async fn rem_s2_dedupes_on_the_origin_and_the_id_so_two_hosts_may_send_the_same_id_and_neither_is_lost()
 {
    let rig = Rig::new();
    let remote = |origin: &str, text: &str| RemoteMail {
        id: "same".to_owned(),
        origin: origin.to_owned(),
        from: "x".to_owned(),
        to: "p2".to_owned(),
        text: text.to_owned(),
    };
    rig.store.receive(remote("remote:one", "a")).await.unwrap();
    rig.store.receive(remote("remote:two", "b")).await.unwrap();
    rig.store.receive(remote("remote:one", "a")).await.unwrap();
    assert_eq!(texts(&rig.store.inbox_of("p2")), ["a", "b"]);
}

#[tokio::test]
async fn rem_s3_answers_stored_once_for_the_same_mail_received_twice_at_the_same_time() {
    let rig = Rig::new();
    let draft = RemoteMail {
        id: "dup".to_owned(),
        origin: "remote:h".to_owned(),
        from: "x".to_owned(),
        to: "p3".to_owned(),
        text: "once".to_owned(),
    };
    let (one, two) = tokio::join!(rig.store.receive(draft.clone()), rig.store.receive(draft));
    assert_eq!(one.unwrap(), ReceiveOutcome::Stored);
    assert_eq!(two.unwrap(), ReceiveOutcome::Stored);
    assert_eq!(rig.store.inbox_of("p3").len(), 1);
}

#[tokio::test]
async fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let rig = Rig::new();
    fs::create_dir_all(rig.file().parent().unwrap()).unwrap();
    fs::copy(fixture("bus-before.json"), rig.file()).unwrap();

    let inbox = rig.store.inbox_of("b");
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].text.as_deref(), Some("build é green\nsecond line"));
    assert_eq!(inbox[0].preview, "build é green");
    let task = &rig.store.inbox_of("c")[0];
    assert!(task.task && task.wakes);
    assert_eq!(task.route.as_deref(), Some("remote:h"));
    assert_eq!(task.origin.as_deref(), Some("remote:h"));
    let delivered = rig.store.get_mail("m3").unwrap();
    assert_eq!(delivered.state, MailState::Delivered);
    assert_eq!(delivered.via, Some(MailVia::Read));
    assert_eq!(rig.store.watches_of("boss")[0].until, ["done", "command"]);
    let failed = rig.store.mail_views();
    assert_eq!(failed.last().map(|view| view.id.as_str()), Some("m4"));

    rig.store.dismiss_failed("e");
    rig.store.flush().await;
    assert_eq!(
        fs::read(rig.file()).unwrap(),
        fs::read(fixture("bus-after.json")).unwrap()
    );
}

#[tokio::test]
async fn keeps_the_handoffs_and_the_wake_times_of_a_loaded_file_when_it_saves() {
    let rig = Rig::new();
    fs::create_dir_all(rig.file().parent().unwrap()).unwrap();
    let handoff = json!({
        "id": "h1", "from": "a", "to": "b", "task": "t", "summary": "s", "state": "claimed",
        "context": {"artifacts": ["x"], "workDir": "/w"}, "ts": "2026-10-18T10:00:00.000Z",
        "updatedAt": "2026-10-18T10:00:00.000Z"
    });
    fs::write(
        rig.file(),
        json!({"mail": [], "handoffs": [handoff.clone()], "watches": [], "wakes": {"ext": [5]}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(rig.store.handoffs().len(), 1);
    rig.ab("hi");
    rig.store.flush().await;
    let saved: Value = serde_json::from_str(&fs::read_to_string(rig.file()).unwrap()).unwrap();
    assert_eq!(saved["handoffs"], json!([handoff]));
    assert_eq!(saved["wakes"], json!({"ext": [5]}));
}

#[tokio::test]
async fn gives_a_new_message_the_given_id_a_preview_and_the_flags_of_its_draft() {
    let rig = Rig::new();
    let mail = rig.store.enqueue(MailDraft {
        id: Some("fixed-id".to_owned()),
        route: Some("remote:h".to_owned()),
        origin: Some("remote:h".to_owned()),
        task: true,
        wakes: true,
        ..MailDraft::new("a", "b", "first line\nsecond line")
    });
    assert_eq!(mail.id, "fixed-id");
    assert_eq!(mail.kind, MailKind::Message);
    assert_eq!(mail.state, MailState::Queued);
    assert_eq!(mail.preview, "first line");
    assert!(mail.task && mail.wakes && !mail.quiet);
    assert_eq!(mail.route.as_deref(), Some("remote:h"));
    assert_eq!(mail.origin.as_deref(), Some("remote:h"));
    let generated = rig.ab("x");
    assert!(!generated.id.is_empty());
    assert_ne!(generated.id, mail.id);
}

#[tokio::test]
async fn reports_a_task_as_a_task_in_the_observation() {
    let rig = Rig::new();
    rig.store.enqueue(MailDraft {
        task: true,
        ..MailDraft::new("a", "b", "do it")
    });
    rig.ab("hi");
    let kinds: Vec<_> = rig
        .observed
        .lock()
        .unwrap()
        .iter()
        .map(|observation| observation.kind)
        .collect();
    assert_eq!(kinds, [BusKind::Task, BusKind::Message]);
}

#[tokio::test]
async fn announces_each_queued_message_to_the_queue_listener_but_not_a_quiet_one_or_one_a_waiter_took()
 {
    let rig = Rig::new();
    let mut queued = rig.store.on_mail_queued();
    let first = rig.ab("plain");
    rig.store.enqueue(MailDraft {
        quiet: true,
        ..MailDraft::new("a", "b", "report")
    });
    let mut waiter = rig.store.add_waiter("c", None);
    rig.send("to a waiter", "c", "a");
    assert!(waiter.try_recv().is_some());
    assert_eq!(ids(&drained(&mut queued)), [first.id]);
}

#[tokio::test]
async fn limits_a_senders_list_to_its_last_fifty_messages() {
    let rig = Rig::new();
    for i in 0..60 {
        rig.ab(&format!("m{i}"));
    }
    let sent = rig.store.sent_by("a");
    assert_eq!(sent.len(), 50);
    assert_eq!(sent[0].preview, "m10");
    assert_eq!(sent[49].preview, "m59");
}

#[tokio::test]
async fn sets_the_lease_deadline_from_the_clock() {
    let rig = Rig::new();
    rig.ab("hi");
    let handed = rig.store.lease_mail("b", MailVia::Turn, all).unwrap();
    let leased = &handed.messages[0];
    assert_eq!(leased.leased_until, Some(rig.time.now() + LEASE_MS));
    assert_eq!(leased.lease.as_deref(), Some(handed.lease.as_str()));
    assert_eq!(leased.via, Some(MailVia::Turn));
}

#[tokio::test]
async fn fails_only_the_mail_of_one_lease_with_the_given_reason() {
    let rig = Rig::new();
    let one = rig.ab("one");
    let handed = rig
        .store
        .lease_mail("b", MailVia::Prompt, |mail| mail.id == one.id)
        .unwrap();
    let two = rig.ab("two");
    rig.store.fail_leased("c", &handed.lease, "wrong receiver");
    assert_eq!(
        rig.store.get_mail(&one.id).unwrap().state,
        MailState::Leased
    );
    rig.store.fail_leased("b", &handed.lease, "agent-refused");
    let failed = rig.store.get_mail(&one.id).unwrap();
    assert_eq!(failed.state, MailState::Failed);
    assert_eq!(failed.reason.as_deref(), Some("agent-refused"));
    assert!(failed.text.is_none() && failed.lease.is_none() && failed.leased_until.is_none());
    assert_eq!(
        rig.store.get_mail(&two.id).unwrap().state,
        MailState::Queued
    );
    assert_eq!(
        *rig.journal.mail.lock().unwrap(),
        [("agent-refused".to_owned(), 0, "b".to_owned())]
    );
}

#[tokio::test]
async fn releases_a_lease_only_for_its_receiver_and_clears_the_lease_fields() {
    let rig = Rig::new();
    let mail = rig.ab("hi");
    let handed = rig.store.lease_mail("b", MailVia::Prompt, all).unwrap();
    rig.store.release_mail("c", &handed.lease);
    assert_eq!(
        rig.store.get_mail(&mail.id).unwrap().state,
        MailState::Leased
    );
    rig.store.release_mail("b", &handed.lease);
    let back = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(back.state, MailState::Queued);
    assert!(back.lease.is_none() && back.leased_until.is_none());
}

#[tokio::test]
async fn fails_a_leased_message_whose_lease_ran_out_when_it_is_also_older_than_24_hours() {
    let rig = Rig::new();
    let mail = rig.ab("hi");
    rig.store.lease_mail("b", MailVia::Prompt, all);
    rig.time.advance(MAIL_TTL_MS + 1);
    let failed = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(failed.state, MailState::Failed);
    assert_eq!(failed.reason.as_deref(), Some("expired:queued"));
    assert_eq!(rig.journal.lease_timeouts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn keeps_undelivered_mail_of_any_age_when_it_prunes_history() {
    let rig = Rig::new();
    let mail = rig.store.enqueue(MailDraft::new("a", "b", "hi"));
    rig.store.lease_mail("b", MailVia::Prompt, all);
    rig.time.advance(HISTORY_MS + 1000);
    assert!(rig.store.get_mail(&mail.id).is_some());
}

#[tokio::test]
async fn counts_a_panes_queued_failed_and_sent_mail_with_the_oldest_wait_and_the_last_failure() {
    let rig = Rig::new();
    rig.ab("old");
    rig.time.advance(4000);
    rig.ab("newer");
    rig.send("out", "c", "b");
    rig.store.enqueue(MailDraft {
        quiet: true,
        ..MailDraft::new("a", "b", "report")
    });
    let failing = rig.send("lost", "d", "b");
    rig.store.fail_pane_mail("d");
    rig.send("to b lost", "e", "a");
    rig.store.post_event("b", "c", "status");
    assert_eq!(
        rig.store.get_mail(&failing.id).unwrap().state,
        MailState::Failed
    );

    let counts = rig.store.mail_counts("b");
    assert_eq!(counts.queued, 2);
    assert_eq!(counts.failed, 0);
    assert_eq!(counts.sent_queued, 1);
    assert_eq!(counts.sent_failed, 1);
    assert_eq!(counts.oldest_queued_ms, Some(4000));
    assert_eq!(counts.last_failure, None);

    rig.store.fail_pane_mail("b");
    let after = rig.store.mail_counts("b");
    assert_eq!(after.queued, 0);
    assert_eq!(after.failed, 2);
    assert_eq!(after.last_failure.as_deref(), Some("pane-closed"));
    assert_eq!(after.oldest_queued_ms, None);
}

#[tokio::test]
async fn counts_queued_mail_by_receiver_without_quiet_mail_leased_mail_or_events() {
    let rig = Rig::new();
    rig.ab("one");
    rig.ab("two");
    rig.send("three", "c", "a");
    rig.store.enqueue(MailDraft {
        quiet: true,
        ..MailDraft::new("a", "b", "report")
    });
    rig.send("leased", "d", "a");
    rig.store.lease_mail("d", MailVia::Prompt, all);
    let counts = rig.store.queued_counts();
    assert_eq!(counts.get("b"), Some(&2));
    assert_eq!(counts.get("c"), Some(&1));
    assert_eq!(counts.get("d"), None);
}

#[tokio::test]
async fn sets_the_pending_reason_only_on_queued_mail() {
    let rig = Rig::new();
    let queued = rig.ab("one");
    rig.store.set_pending(&queued.id, MailPending::Working);
    assert_eq!(
        rig.store.get_mail(&queued.id).unwrap().pending,
        Some(MailPending::Working)
    );
    rig.store.set_pending(&queued.id, MailPending::RateLimited);
    assert_eq!(
        rig.store.get_mail(&queued.id).unwrap().pending,
        Some(MailPending::RateLimited)
    );
    rig.store.lease_mail("b", MailVia::Prompt, all);
    rig.store.set_pending(&queued.id, MailPending::Hibernated);
    assert_eq!(
        rig.store.get_mail(&queued.id).unwrap().pending,
        Some(MailPending::RateLimited)
    );
    rig.store.set_pending("missing", MailPending::Draft);
}

#[tokio::test]
async fn allows_a_wake_up_to_the_maximum_in_the_window_and_forgets_old_ones() {
    let rig = Rig::new();
    let window = 60_000;
    assert!(rig.store.claim_wake("ext", START, 2, window));
    assert!(rig.store.claim_wake("ext", START + 1000, 2, window));
    assert!(!rig.store.claim_wake("ext", START + 2000, 2, window));
    assert!(rig.store.claim_wake("other", START + 2000, 2, window));
    let later = START + window + 2000;
    assert!(rig.store.claim_wake("ext", later, 2, window));
    assert!(rig.store.claim_wake("ext", later + 1, 2, window));
    assert!(!rig.store.claim_wake("ext", later + 2, 2, window));
    rig.store.flush().await;
    let saved: Value = serde_json::from_str(&fs::read_to_string(rig.file()).unwrap()).unwrap();
    assert_eq!(saved["wakes"]["ext"], json!([later, later + 1]));
    assert!(saved["wakes"].get("other").is_none());
}

#[tokio::test]
async fn knows_who_mailed_whom_and_the_peers_of_a_route() {
    let rig = Rig::new();
    rig.send("hi", "remote:h:1", "local");
    rig.send("hello", "local2", "remote:h:2");
    rig.send("plain", "b", "a");
    assert!(rig.store.has_mailed("local", "remote:h:1"));
    assert!(!rig.store.has_mailed("remote:h:1", "local"));
    let mut peers = rig.store.peers_of_route("remote:h");
    peers.sort();
    assert_eq!(peers, ["local", "local2"]);
    assert!(rig.store.peers_of_route("remote:x").is_empty());
}

#[tokio::test]
async fn lists_the_queued_mail_of_a_route_as_copies_and_counts_its_failures_since_a_time() {
    let rig = Rig::new();
    let routed = |to: &str, route: &str| MailDraft {
        route: Some(route.to_owned()),
        ..MailDraft::new("a", to, "hi")
    };
    let one = rig.store.enqueue(routed("p1", "remote:h"));
    rig.store.enqueue(routed("p2", "remote:other"));
    rig.ab("no route");
    assert_eq!(ids(&rig.store.queued_on_route("remote:h")), [one.id]);

    rig.store.fail_pane_mail("p1");
    rig.time.advance(1000);
    let later = rig.store.enqueue(routed("p3", "remote:h"));
    rig.store.fail_pane_mail("p3");
    assert_eq!(
        rig.store.get_mail(&later.id).unwrap().state,
        MailState::Failed
    );
    let since = rig.store.get_mail(&later.id).unwrap().failed_at.unwrap();
    assert_eq!(rig.store.failed_on_route("remote:h", &since), 1);
    assert_eq!(rig.store.failed_on_route("remote:h", ""), 2);
    assert_eq!(rig.store.failed_on_route("remote:other", ""), 0);
}

#[tokio::test]
async fn marks_a_queued_routed_message_delivered_by_remote_when_the_remote_stored_it() {
    let rig = Rig::new();
    let mail = rig.store.enqueue(MailDraft {
        route: Some("remote:h".to_owned()),
        ..MailDraft::new("a", "p1", "hi")
    });
    assert!(!rig.store.stored_on_route("remote:other", &mail.id));
    assert!(!rig.store.stored_on_route("remote:h", "missing"));
    assert_eq!(
        rig.store.get_mail(&mail.id).unwrap().state,
        MailState::Queued
    );
    assert!(rig.store.stored_on_route("remote:h", &mail.id));
    let delivered = rig.store.get_mail(&mail.id).unwrap();
    assert_eq!(delivered.state, MailState::Delivered);
    assert_eq!(delivered.via, Some(MailVia::Remote));
    assert!(delivered.text.is_none());
    assert!(rig.store.stored_on_route("remote:h", &mail.id));
    assert_eq!(rig.observations().len(), 2);
}

#[tokio::test]
async fn fails_a_queued_routed_message_with_the_reason_the_remote_gave_and_leaves_other_states_alone()
 {
    let rig = Rig::new();
    let routed = |to: &str| MailDraft {
        route: Some("remote:h".to_owned()),
        ..MailDraft::new("a", to, "hi")
    };
    let queued = rig.store.enqueue(routed("p1"));
    let settled = rig.store.enqueue(routed("p2"));
    rig.store.stored_on_route("remote:h", &settled.id);
    assert!(!rig.store.refused_on_route("remote:other", &queued.id, "no"));
    assert!(
        rig.store
            .refused_on_route("remote:h", &queued.id, "agent-refused")
    );
    let failed = rig.store.get_mail(&queued.id).unwrap();
    assert_eq!(failed.state, MailState::Failed);
    assert_eq!(failed.reason.as_deref(), Some("agent-refused"));
    assert!(rig.store.refused_on_route("remote:h", &settled.id, "late"));
    assert_eq!(
        rig.store.get_mail(&settled.id).unwrap().state,
        MailState::Delivered
    );
    assert!(!rig.store.refused_on_route("remote:h", "missing", "x"));
}

#[tokio::test]
async fn refuses_a_received_message_when_the_inbox_of_its_receiver_is_full() {
    let rig = Rig::new();
    for i in 0..INBOX_MAX {
        rig.send(&format!("m{i}"), "p4", "a");
    }
    let outcome = rig
        .store
        .receive(RemoteMail {
            id: "late".to_owned(),
            origin: "remote:h".to_owned(),
            from: "x".to_owned(),
            to: "p4".to_owned(),
            text: "no room".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(outcome, ReceiveOutcome::Full);
    assert_eq!(rig.store.inbox_of("p4").len(), INBOX_MAX);
}

#[tokio::test]
async fn hands_a_received_message_to_a_parked_waiter_and_stamps_its_origin() {
    let rig = Rig::new();
    let mut waiter = rig.store.add_waiter("p5", None);
    rig.store
        .receive(RemoteMail {
            id: "r1".to_owned(),
            origin: "remote:h".to_owned(),
            from: "remote:h:1".to_owned(),
            to: "p5".to_owned(),
            text: "hello".to_owned(),
        })
        .await
        .unwrap();
    let handed = waiter.try_recv().expect("handed");
    assert_eq!(handed.messages[0].id, "r1");
    assert_eq!(handed.messages[0].origin.as_deref(), Some("remote:h"));
}

#[tokio::test]
async fn posts_a_bus_message_quietly_and_tells_a_pane_as_ostia() {
    let rig = Rig::new();
    let quiet = rig.store.post_bus_message("a", "b", "report");
    let told = rig.store.tell_pane("b", "notice");
    let quiet_mail = rig.store.get_mail(&quiet).unwrap();
    assert!(quiet_mail.quiet);
    let told_mail = rig.store.get_mail(&told).unwrap();
    assert!(!told_mail.quiet);
    assert_eq!(told_mail.from, "ostia");
    assert_eq!(told_mail.to, "b");
    assert_eq!(told_mail.text.as_deref(), Some("notice"));
    assert_eq!(rig.observations().len(), 1);
}

#[tokio::test]
async fn dismisses_only_failed_mail_of_the_pane_that_is_not_dismissed_yet() {
    let rig = Rig::new();
    let failed = rig.ab("lost");
    rig.store.fail_pane_mail("b");
    let queued = rig.ab("queued");
    rig.store.dismiss_failed("b");
    assert!(rig.store.get_mail(&failed.id).unwrap().dismissed);
    assert!(!rig.store.get_mail(&queued.id).unwrap().dismissed);
}
