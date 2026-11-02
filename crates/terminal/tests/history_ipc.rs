#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::Arc;

use history_support::{mark, numbered};
use ostia_terminal::history_feed::{HistoryFeed, SpillClient};
use ostia_terminal::history_ipc::{HistoryIpc, HistoryIpcDeps};
use ostia_terminal::history_search::{
    HistorySearchOptions, Span, line_matcher, output_text, same_command,
};
use ostia_terminal::pane_histories::{PaneHistories, PaneHistoriesDeps};
use ostia_terminal::scrollback_history::{HistoryBlockRange, HistoryMatch, ScrollbackHistory};
use serde_json::json;
use tempfile::TempDir;

const ESC: &str = "\x1b";

struct Setup {
    ipc: HistoryIpc,
    histories: PaneHistories,
    feed: HistoryFeed,
    _root: TempDir,
}

fn setup() -> Setup {
    let root = tempfile::Builder::new()
        .prefix("history-ipc-")
        .tempdir()
        .unwrap();
    let histories = PaneHistories::new(PaneHistoriesDeps {
        root: root.path().to_path_buf(),
        setting: Arc::new(|| ScrollbackHistory::Unlimited),
        start_spill: Arc::new(|| SpillClient::spawn().unwrap()),
        free_bytes: None,
        on_failed: None,
        segment_bytes: None,
    });
    let feed = histories.feed_for("p1", 80, 24, None).unwrap();
    let ipc = HistoryIpc::new(HistoryIpcDeps {
        histories: Some(histories.clone()),
        window_of_pane: Arc::new(|pane| (pane == "p1").then(|| "7".to_string())),
        feed_of_pane: {
            let feed = feed.clone();
            Arc::new(move |pane| (pane == "p1").then(|| feed.clone()))
        },
    });
    Setup {
        ipc,
        histories,
        feed,
        _root: root,
    }
}

impl Setup {
    async fn write(&self, data: &str) {
        self.feed.write(data);
        self.feed.tail().await;
    }

    fn send(&self, data: &str) {
        self.feed.write(data);
    }

    async fn finish(self) {
        drop(self.feed.close());
        self.histories.remove_all().await.unwrap();
    }
}

fn lines_of(page: &str) -> Vec<String> {
    page.trim_end()
        .split("\r\n")
        .map(ToString::to_string)
        .collect()
}

fn build_command() -> String {
    format!(
        "{}$ {ESC}]633;E;build;n0nce\x07{}build\r\n{}",
        mark("A"),
        mark("B"),
        mark("C")
    )
}

#[tokio::test]
async fn answers_only_the_window_that_owns_the_pane() {
    let s = setup();
    s.write(&numbered(0, 10)).await;
    assert!(
        s.ipc
            .history_read("8", &json!("p1"), &json!(0), &json!(10))
            .await
            .is_none()
    );
    assert!(
        s.ipc
            .history_search("8", &json!("p1"), &json!("out"), &json!({}), &json!(0))
            .await
            .is_none()
    );
    assert!(
        s.ipc
            .block_output("8", &json!("p1"), &json!(1), &json!(""))
            .await
            .is_none()
    );
    assert!(
        s.ipc
            .history_read("7", &json!("p2"), &json!(0), &json!(10))
            .await
            .is_none()
    );
    s.finish().await;
}

#[tokio::test]
async fn reads_spilled_lines_and_the_unspilled_screen_as_one_numbered_history() {
    let s = setup();
    s.write(&numbered(0, 3000)).await;
    let page = s
        .ipc
        .history_read("7", &json!("p1"), &json!(2990), &json!(20))
        .await
        .unwrap();
    assert_eq!(page.first, 0);
    assert_eq!(page.end, 3000);
    assert_eq!(page.from, 2990);
    assert_eq!(page.lines, lines_of(&numbered(2990, 10)));
    s.finish().await;
}

#[tokio::test]
async fn searches_only_lines_older_than_the_live_terminal_holds_newest_matches_last() {
    let s = setup();
    let text: String = (0..3000).map(|i| format!("needle {i}\r\n")).collect();
    s.write(&text).await;
    let result = s
        .ipc
        .history_search(
            "7",
            &json!("p1"),
            &json!("NEEDLE 2"),
            &json!({}),
            &json!(1000),
        )
        .await
        .unwrap();
    assert_eq!(result.count, 1 + 10 + 100);
    assert_eq!(
        result.matches.last(),
        Some(&HistoryMatch {
            line: 299,
            start: 0,
            end: 8
        })
    );
    let all = s
        .ipc
        .history_search("7", &json!("p1"), &json!("needle"), &json!({}), &json!(0))
        .await
        .unwrap();
    assert!(all.count > 2000);
    assert_eq!(all.matches.len(), 1000);
    assert_eq!(all.matches.last().map(|m| m.line), Some(all.count - 1));
    s.finish().await;
}

#[tokio::test]
async fn returns_a_spilled_block_whole_without_the_next_prompt() {
    let s = setup();
    s.write(&build_command()).await;
    s.write(&numbered(0, 2500)).await;
    s.write(&format!("{}{}$ ", mark("D;1"), mark("A"))).await;
    let output = s
        .ipc
        .block_output("7", &json!("p1"), &json!(1), &json!("build"))
        .await
        .unwrap();
    let expected: Vec<String> = lines_of(&numbered(0, 2500));
    assert_eq!(
        output
            .split('\n')
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        expected
    );
    assert!(
        s.ipc
            .block_output("7", &json!("p1"), &json!(1), &json!("other"))
            .await
            .is_none()
    );
    assert_eq!(
        s.ipc
            .history_block("7", &json!("p1"), &json!(1), &json!("build"))
            .await,
        Some(HistoryBlockRange {
            start: 1,
            end: 2501
        })
    );
    s.finish().await;
}

#[tokio::test]
async fn reads_what_was_just_written_without_waiting_for_the_pane_to_go_quiet() {
    let s = setup();
    s.send(&numbered(0, 3000));
    let page = s
        .ipc
        .history_read("7", &json!("p1"), &json!(0), &json!(10))
        .await
        .unwrap();
    assert_eq!(page.end, 3000);
    assert_eq!(page.lines, lines_of(&numbered(0, 10)));
    s.finish().await;
}

#[tokio::test]
async fn never_shows_a_cleared_line_even_when_asked_right_after_the_clear() {
    let s = setup();
    s.write(&build_command()).await;
    s.write(&numbered(0, 2500)).await;
    s.write(&format!("{}{}$ ", mark("D;0"), mark("A"))).await;
    s.send(&format!("{ESC}[3J"));
    assert!(
        s.ipc
            .history_block("7", &json!("p1"), &json!(1), &json!("build"))
            .await
            .is_none()
    );
    let page = s
        .ipc
        .history_read("7", &json!("p1"), &json!(0), &json!(5000))
        .await
        .unwrap();
    assert!(!page.lines.contains(&"out 10".to_string()));
    let found = s
        .ipc
        .history_search("7", &json!("p1"), &json!("out 10"), &json!({}), &json!(0))
        .await
        .unwrap();
    assert_eq!(found.count, 0);
    s.finish().await;
}

#[test]
fn matches_literally_by_default_ignoring_case() {
    let span = |start, end| vec![Span { start, end }];
    let plain = HistorySearchOptions::default();
    let regex = HistorySearchOptions {
        regex: true,
        ..HistorySearchOptions::default()
    };
    let case = HistorySearchOptions {
        case_sensitive: true,
        ..HistorySearchOptions::default()
    };
    let word = HistorySearchOptions {
        whole_word: true,
        ..HistorySearchOptions::default()
    };
    assert_eq!(
        line_matcher("a.b", &plain).unwrap().find("A.B axb"),
        span(0, 3)
    );
    assert_eq!(line_matcher("a.b", &regex).unwrap().find("axb"), span(0, 3));
    assert_eq!(line_matcher("ab", &case).unwrap().find("AB ab"), span(3, 5));
    assert_eq!(
        line_matcher("ab", &word).unwrap().find("abc ab"),
        span(4, 6)
    );
    assert!(line_matcher("(", &regex).is_none());
}

#[test]
fn cuts_the_last_line_at_the_end_column_and_drops_colours_and_trailing_blanks() {
    let lines = |items: &[&str]| -> Vec<String> { items.iter().map(ToString::to_string).collect() };
    assert_eq!(
        output_text(&lines(&["\x1b[31mred\x1b[0m  ", "two$ prompt"]), Some(3)),
        "red\ntwo"
    );
    assert_eq!(output_text(&lines(&["one", "$ prompt"]), Some(0)), "one");
    assert_eq!(output_text(&lines(&["one", "two", ""]), None), "one\ntwo");
}

#[test]
fn compares_commands_by_their_first_line() {
    assert!(same_command(None, "ls"));
    assert!(same_command(Some("cat <<EOF\nx\nEOF"), "cat <<EOF"));
    assert!(!same_command(Some("ls"), "make"));
}
