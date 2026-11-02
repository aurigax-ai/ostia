#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_base::Result;
use ostia_terminal::tmux_pane::{PaneServer, TmuxPane};
use tokio::sync::mpsc::UnboundedReceiver;

#[derive(Clone, Copy, Default)]
struct NullServer;

impl PaneServer for NullServer {
    fn send(&self, _line: &str) {}

    async fn command(&self, _line: &str) -> Result<Vec<String>> {
        Ok(Vec::new())
    }

    async fn batch(
        &self,
        _lines: &[String],
        _on_last_reply: &(dyn Fn() + Send + Sync),
    ) -> Result<Vec<Vec<String>>> {
        Ok(Vec::new())
    }

    fn forget(&self, _pane_id: &str) {}

    async fn kill_window(&self, _window_id: &str) {}

    fn retry(&self) {}
}

#[derive(Clone, Copy, Default)]
struct ZeroReplyServer;

impl PaneServer for ZeroReplyServer {
    fn send(&self, _line: &str) {}

    async fn command(&self, _line: &str) -> Result<Vec<String>> {
        Ok(Vec::new())
    }

    async fn batch(
        &self,
        lines: &[String],
        _on_last_reply: &(dyn Fn() + Send + Sync),
    ) -> Result<Vec<Vec<String>>> {
        Ok(lines.iter().map(|_| vec!["0".to_owned()]).collect())
    }

    fn forget(&self, _pane_id: &str) {}

    async fn kill_window(&self, _window_id: &str) {}

    fn retry(&self) {}
}

fn seen(rx: &mut UnboundedReceiver<String>) -> String {
    let mut out = String::new();
    while let Ok(chunk) = rx.try_recv() {
        out.push_str(&chunk);
    }
    out
}

fn null_pane() -> TmuxPane<NullServer> {
    TmuxPane::new(NullServer, "@1", "%1", 1, 80, 24)
}

#[test]
fn runs_a_waiter_once_after_the_next_foreground_update() {
    let pane = null_pane();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    pane.after_foreground(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    pane.set_foreground("zsh");
    assert_eq!(pane.process(), "zsh");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    pane.set_foreground("claude");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn ksh_t1_never_hands_esc_k_titles_to_listeners_also_when_split() {
    let pane = null_pane();
    let mut rx = pane.on_data();
    pane.deliver("x\x1bkpw");
    pane.deliver("d\x1b");
    pane.deliver("\\y");
    assert_eq!(seen(&mut rx), "xy");
}

#[test]
fn filters_early_output_replayed_to_the_first_listener() {
    let pane = null_pane();
    pane.hold_early_output("\x1bkls\x1b\\ok");
    let mut rx = pane.on_data();
    assert_eq!(seen(&mut rx), "ok");
}

#[test]
fn filters_early_output_before_later_output_arrives() {
    let pane = null_pane();
    pane.hold_early_output("ok");
    pane.deliver("\x1bkt");
    let mut rx = pane.on_data();
    assert_eq!(seen(&mut rx), "ok");
}

#[test]
fn feeds_skipped_early_output_to_the_filter_so_a_title_begun_in_it_does_not_leak() {
    let pane = null_pane();
    pane.skip_early_output("before\x1bkls");
    let mut rx = pane.on_data();
    pane.deliver("-la\x1b\\after");
    assert_eq!(seen(&mut rx), "after");
}

#[test]
fn does_not_replay_skipped_early_output_to_the_first_listener() {
    let pane = null_pane();
    pane.skip_early_output("before");
    let mut rx = pane.on_data();
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn releases_output_held_during_a_snapshot_without_filtering_it_twice() {
    let pane = TmuxPane::new(ZeroReplyServer, "@1", "%1", 1, 80, 24);
    let mut rx = pane.on_data();
    pane.snapshot(80, 24).await.unwrap();
    pane.deliver("hello\x1bkti");
    pane.live();
    pane.deliver("tle\x1b\\!");
    assert_eq!(seen(&mut rx), "hello!");
}
