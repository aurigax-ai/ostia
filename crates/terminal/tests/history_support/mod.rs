#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ostia_terminal::history_records::new_history_key;
use ostia_terminal::pane_history::{PaneHistory, PaneHistoryDeps};
use parking_lot::Mutex;
use tempfile::TempDir;

pub type EnsureSpace = Arc<dyn Fn(&PaneHistory) -> bool + Send + Sync>;

#[derive(Default)]
pub struct HistoryOptions {
    pub limit_bytes: Option<u64>,
    pub segment_bytes: Option<u64>,
    pub ensure_space: Option<EnsureSpace>,
}

pub struct Harness {
    pub history: PaneHistory,
    pub dir: PathBuf,
    pub failures: Arc<Mutex<Vec<String>>>,
    pub root: TempDir,
}

pub fn make_history(options: HistoryOptions) -> Harness {
    let root = tempfile::Builder::new()
        .prefix("pane-history-")
        .tempdir()
        .unwrap();
    let dir = root.path().join("pane");
    let failures = Arc::new(Mutex::new(Vec::new()));
    let recorded = failures.clone();
    let limit = options.limit_bytes;
    let history = PaneHistory::new(PaneHistoryDeps {
        dir: dir.clone(),
        key: new_history_key(),
        limit_bytes: Arc::new(move || limit),
        ensure_space: options.ensure_space.unwrap_or_else(|| Arc::new(|_| true)),
        on_failed: Arc::new(move |reason| recorded.lock().push(reason.to_string())),
        segment_bytes: options.segment_bytes,
    });
    Harness {
        history,
        dir,
        failures,
        root,
    }
}

pub fn put(history: &PaneHistory, lines: &[String]) {
    history.append(&lines.join("\n"), u64::try_from(lines.len()).unwrap());
}

pub fn numbered(from: u64, count: u64) -> String {
    (0..count)
        .map(|i| format!("out {}\r\n", from + i))
        .collect()
}

pub fn numbered_lines(from: u64, count: u64) -> Vec<String> {
    (0..count).map(|i| format!("out {}", from + i)).collect()
}

pub fn mark(kind: &str) -> String {
    format!("\x1b]133;{kind}\x07")
}

pub fn strip_vt(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

pub async fn plain(history: &PaneHistory) -> Vec<String> {
    let first = history.first();
    history
        .read(first, history.end() - first)
        .await
        .iter()
        .map(|line| strip_vt(line))
        .collect()
}

pub async fn wait_for(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "condition not reached in 10 s");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
