#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_base::PaneId;
use ostia_terminal::pty_size::{
    HoldOutcome, PtyHold, PtySizeEntry, ScreenMirror, SizeWindow, SizedPty, hold_pty, release_pty,
    resize_for_all, resize_from_desktop, resize_pty,
};
use parking_lot::Mutex;

type Log = Arc<Mutex<Vec<String>>>;

struct FakePty {
    cols: u16,
    rows: u16,
    fail: bool,
    log: Log,
}

impl SizedPty for FakePty {
    fn cols(&self) -> u16 {
        self.cols
    }

    fn rows(&self) -> u16 {
        self.rows
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        if self.fail {
            return Err("resize failed".to_owned());
        }
        self.cols = cols;
        self.rows = rows;
        self.log.lock().push(format!("pty {cols}x{rows}"));
        Ok(())
    }
}

struct FakeMirror {
    log: Log,
}

impl ScreenMirror for FakeMirror {
    fn resize(&mut self, cols: u16, rows: u16) {
        self.log.lock().push(format!("mirror {cols}x{rows}"));
    }
}

struct FakeWindow {
    name: &'static str,
    destroyed: bool,
    log: Log,
}

impl SizeWindow for FakeWindow {
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn send_size(&self, pane_id: &PaneId, cols: u16, rows: u16, held: bool) {
        self.log.lock().push(format!(
            "window {} {} {cols}x{rows} held={held}",
            self.name,
            pane_id.as_str()
        ));
    }
}

fn pane() -> PaneId {
    PaneId::new("p1")
}

fn entry_at(cols: u16, rows: u16) -> (PtySizeEntry, Log) {
    let log: Log = Arc::default();
    let entry = PtySizeEntry::new(
        Box::new(FakePty {
            cols,
            rows,
            fail: false,
            log: log.clone(),
        }),
        Box::new(FakeMirror { log: log.clone() }),
    );
    (entry, log)
}

fn failing_entry_at(cols: u16, rows: u16) -> (PtySizeEntry, Log) {
    let log: Log = Arc::default();
    let entry = PtySizeEntry::new(
        Box::new(FakePty {
            cols,
            rows,
            fail: true,
            log: log.clone(),
        }),
        Box::new(FakeMirror { log: log.clone() }),
    );
    (entry, log)
}

fn add_window(entry: &mut PtySizeEntry, log: &Log, id: &str, name: &'static str, destroyed: bool) {
    entry.add_window(
        id.to_owned(),
        Box::new(FakeWindow {
            name,
            destroyed,
            log: log.clone(),
        }),
    );
}

fn listen(entry: &mut PtySizeEntry, log: &Log) {
    let log = log.clone();
    entry.add_size_listener(Box::new(move |cols, rows| {
        log.lock().push(format!("listener {cols}x{rows}"));
    }));
}

fn lines(log: &Log) -> Vec<String> {
    log.lock().clone()
}

fn clear(log: &Log) {
    log.lock().clear();
}

#[test]
fn resize_pty_without_an_entry_does_nothing() {
    resize_pty(None, 100, 30);
}

#[test]
fn resize_pty_resizes_the_pty_then_the_mirror_then_tells_listeners() {
    let (mut entry, log) = entry_at(80, 24);
    listen(&mut entry, &log);
    resize_pty(Some(&mut entry), 100, 30);
    assert_eq!(
        lines(&log),
        ["pty 100x30", "mirror 100x30", "listener 100x30"]
    );
}

#[test]
fn resize_pty_falls_back_to_80_by_24_for_zero_sizes() {
    let table = [(0, 0, "80x24"), (0, 30, "80x30"), (100, 0, "100x24")];
    for (cols, rows, expected) in table {
        let (mut entry, log) = entry_at(10, 10);
        resize_pty(Some(&mut entry), cols, rows);
        assert_eq!(
            lines(&log)[0],
            format!("pty {expected}"),
            "row {cols}x{rows}"
        );
    }
}

#[test]
fn resize_pty_does_not_tell_listeners_when_the_size_is_unchanged() {
    let (mut entry, log) = entry_at(80, 24);
    listen(&mut entry, &log);
    resize_pty(Some(&mut entry), 80, 24);
    assert_eq!(lines(&log), ["pty 80x24", "mirror 80x24"]);
}

#[test]
fn resize_pty_tells_listeners_when_only_one_side_changes() {
    let (mut entry, log) = entry_at(80, 24);
    listen(&mut entry, &log);
    resize_pty(Some(&mut entry), 80, 25);
    assert_eq!(lines(&log), ["pty 80x25", "mirror 80x25", "listener 80x25"]);
}

#[test]
fn resize_pty_stops_before_the_mirror_and_listeners_when_the_pty_refuses() {
    let (mut entry, log) = failing_entry_at(80, 24);
    listen(&mut entry, &log);
    resize_pty(Some(&mut entry), 100, 30);
    assert!(lines(&log).is_empty());
}

#[test]
fn resize_pty_tells_every_listener() {
    let (mut entry, log) = entry_at(80, 24);
    listen(&mut entry, &log);
    listen(&mut entry, &log);
    resize_pty(Some(&mut entry), 90, 30);
    let told = lines(&log)
        .iter()
        .filter(|line| line.starts_with("listener"))
        .count();
    assert_eq!(told, 2);
}

#[test]
fn resize_for_all_does_nothing_when_the_pty_already_has_the_size() {
    let (mut entry, log) = entry_at(100, 30);
    add_window(&mut entry, &log, "w1", "a", false);
    resize_for_all(&pane(), &mut entry, 100, 30);
    assert!(lines(&log).is_empty());
}

#[test]
fn resize_for_all_resizes_and_tells_every_window_it_is_not_held() {
    let (mut entry, log) = entry_at(80, 24);
    add_window(&mut entry, &log, "w1", "a", false);
    add_window(&mut entry, &log, "w2", "b", false);
    resize_for_all(&pane(), &mut entry, 100, 30);
    assert_eq!(
        lines(&log),
        [
            "pty 100x30",
            "mirror 100x30",
            "window a p1 100x30 held=false",
            "window b p1 100x30 held=false",
        ]
    );
}

#[test]
fn resize_for_all_tells_windows_it_is_held_while_a_hold_exists() {
    let (mut entry, log) = entry_at(80, 24);
    add_window(&mut entry, &log, "w1", "a", false);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    resize_for_all(&pane(), &mut entry, 60, 22);
    assert_eq!(
        lines(&log),
        ["pty 60x22", "mirror 60x22", "window a p1 60x22 held=true"]
    );
}

#[test]
fn resize_for_all_skips_destroyed_windows() {
    let (mut entry, log) = entry_at(80, 24);
    add_window(&mut entry, &log, "w1", "gone", true);
    add_window(&mut entry, &log, "w2", "live", false);
    resize_for_all(&pane(), &mut entry, 100, 30);
    let windows: Vec<String> = lines(&log)
        .into_iter()
        .filter(|line| line.starts_with("window"))
        .collect();
    assert_eq!(windows, ["window live p1 100x30 held=false"]);
}

#[test]
fn resize_for_all_tells_windows_the_raw_size_while_the_pty_gets_the_fallback() {
    let (mut entry, log) = entry_at(80, 24);
    add_window(&mut entry, &log, "w1", "a", false);
    resize_for_all(&pane(), &mut entry, 0, 0);
    assert_eq!(
        lines(&log),
        ["pty 80x24", "mirror 80x24", "window a p1 0x0 held=false"]
    );
}

#[test]
fn resize_for_all_still_tells_windows_when_the_pty_refuses() {
    let (mut entry, log) = failing_entry_at(80, 24);
    add_window(&mut entry, &log, "w1", "a", false);
    resize_for_all(&pane(), &mut entry, 100, 30);
    assert_eq!(lines(&log), ["window a p1 100x30 held=false"]);
}

#[test]
fn hold_pty_records_the_desktop_size_resizes_and_tells_windows_it_is_held() {
    let (mut entry, log) = entry_at(120, 40);
    add_window(&mut entry, &log, "w1", "a", false);
    let outcome = hold_pty(&pane(), &mut entry, "phone", 50, 20);
    assert_eq!(outcome, HoldOutcome::Ok);
    assert_eq!(
        entry.hold(),
        Some(&PtyHold {
            holder: "phone".to_owned(),
            desktop_cols: 120,
            desktop_rows: 40,
        })
    );
    assert_eq!(
        lines(&log),
        ["pty 50x20", "mirror 50x20", "window a p1 50x20 held=true"]
    );
}

#[test]
fn hold_pty_refuses_a_second_holder_and_changes_nothing() {
    let (mut entry, log) = entry_at(120, 40);
    add_window(&mut entry, &log, "w1", "a", false);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    let outcome = hold_pty(&pane(), &mut entry, "tablet", 60, 30);
    assert_eq!(outcome, HoldOutcome::HeldByOther);
    assert_eq!(entry.hold().unwrap().holder, "phone");
    assert!(lines(&log).is_empty());
}

#[test]
fn hold_pty_lets_the_same_holder_resize_and_keeps_the_first_desktop_size() {
    let (mut entry, log) = entry_at(120, 40);
    add_window(&mut entry, &log, "w1", "a", false);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    let outcome = hold_pty(&pane(), &mut entry, "phone", 60, 30);
    assert_eq!(outcome, HoldOutcome::Ok);
    let hold = entry.hold().unwrap();
    assert_eq!((hold.desktop_cols, hold.desktop_rows), (120, 40));
    assert_eq!(
        lines(&log),
        ["pty 60x30", "mirror 60x30", "window a p1 60x30 held=true"]
    );
}

#[test]
fn hold_pty_keeps_the_hold_and_tells_windows_when_the_pty_refuses() {
    let (mut entry, log) = failing_entry_at(120, 40);
    add_window(&mut entry, &log, "w1", "a", false);
    let outcome = hold_pty(&pane(), &mut entry, "phone", 50, 20);
    assert_eq!(outcome, HoldOutcome::Ok);
    assert_eq!(entry.hold().unwrap().holder, "phone");
    assert_eq!(lines(&log), ["window a p1 50x20 held=true"]);
}

#[test]
fn release_pty_without_a_hold_does_nothing() {
    let (mut entry, log) = entry_at(80, 24);
    add_window(&mut entry, &log, "w1", "a", false);
    release_pty(&pane(), &mut entry, None);
    assert!(lines(&log).is_empty());
    assert!(entry.hold().is_none());
}

#[test]
fn release_pty_restores_the_desktop_size_and_tells_windows_it_is_free() {
    let (mut entry, log) = entry_at(120, 40);
    add_window(&mut entry, &log, "w1", "a", false);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    release_pty(&pane(), &mut entry, Some("phone"));
    assert!(entry.hold().is_none());
    assert_eq!(
        lines(&log),
        [
            "pty 120x40",
            "mirror 120x40",
            "window a p1 120x40 held=false"
        ]
    );
}

#[test]
fn release_pty_ignores_a_holder_that_does_not_own_the_hold() {
    let (mut entry, log) = entry_at(120, 40);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    release_pty(&pane(), &mut entry, Some("tablet"));
    assert_eq!(entry.hold().unwrap().holder, "phone");
    assert!(lines(&log).is_empty());
}

#[test]
fn release_pty_without_a_holder_releases_any_hold() {
    let (mut entry, log) = entry_at(120, 40);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    release_pty(&pane(), &mut entry, None);
    assert!(entry.hold().is_none());
    assert_eq!(lines(&log)[0], "pty 120x40");
}

#[test]
fn release_pty_tells_size_listeners_when_the_size_changes_back() {
    let (mut entry, log) = entry_at(120, 40);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    listen(&mut entry, &log);
    clear(&log);
    release_pty(&pane(), &mut entry, Some("phone"));
    assert!(lines(&log).contains(&"listener 120x40".to_owned()));
}

#[test]
fn resize_from_desktop_clears_a_hold_and_tells_windows_with_the_fallback_size() {
    let (mut entry, log) = entry_at(120, 40);
    add_window(&mut entry, &log, "w1", "a", false);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    resize_from_desktop(&pane(), &mut entry, 0, 0);
    assert!(entry.hold().is_none());
    assert_eq!(
        lines(&log),
        ["pty 80x24", "mirror 80x24", "window a p1 80x24 held=false"]
    );
}

#[test]
fn resize_from_desktop_does_not_tell_windows_when_nothing_was_held() {
    let (mut entry, log) = entry_at(80, 24);
    add_window(&mut entry, &log, "w1", "a", false);
    resize_from_desktop(&pane(), &mut entry, 100, 30);
    assert_eq!(lines(&log), ["pty 100x30", "mirror 100x30"]);
}

#[test]
fn resize_from_desktop_clears_the_hold_even_when_the_pty_refuses() {
    let (mut entry, log) = failing_entry_at(120, 40);
    add_window(&mut entry, &log, "w1", "a", false);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    resize_from_desktop(&pane(), &mut entry, 100, 30);
    assert!(entry.hold().is_none());
    assert_eq!(lines(&log), ["window a p1 100x30 held=false"]);
}

#[test]
fn resize_from_desktop_skips_destroyed_windows() {
    let (mut entry, log) = entry_at(120, 40);
    add_window(&mut entry, &log, "w1", "gone", true);
    hold_pty(&pane(), &mut entry, "phone", 50, 20);
    clear(&log);
    resize_from_desktop(&pane(), &mut entry, 100, 30);
    assert!(!lines(&log).iter().any(|line| line.starts_with("window")));
}
