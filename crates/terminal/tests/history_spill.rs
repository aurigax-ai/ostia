#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use history_support::{
    HistoryOptions, make_history, mark, numbered, numbered_lines, plain, strip_vt,
};
use ostia_terminal::history_feed::{HistoryFeed, SpillClient};
use ostia_terminal::history_spill::{GAP_LINE, SPILL_BATCH};
use ostia_terminal::pane_history::HistoryBlock;

const ESC: &str = "\x1b";

fn batch() -> u64 {
    u64::try_from(SPILL_BATCH).unwrap()
}

struct Pane {
    harness: history_support::Harness,
    client: SpillClient,
}

fn pane() -> Pane {
    Pane {
        harness: make_history(HistoryOptions::default()),
        client: SpillClient::spawn().unwrap(),
    }
}

impl Pane {
    fn open(&self, cols: u16, rows: u16) -> HistoryFeed {
        self.client.open(&self.harness.history, cols, rows, None)
    }
}

#[tokio::test]
async fn spills_each_line_once_in_order_before_the_mirror_trims_it() {
    let pane = pane();
    let feed = pane.open(80, 24);
    feed.write(&numbered(0, 10_000));
    feed.tail().await;
    assert!(pane.harness.history.end() > 10_000 - 2 * batch());
    feed.close().await;
    assert_eq!(
        plain(&pane.harness.history).await,
        numbered_lines(0, 10_000)
    );
}

#[tokio::test]
async fn keeps_a_background_coloured_blank_run() {
    let pane = pane();
    let feed = pane.open(20, 24);
    feed.write(&format!("plain   \r\n{ESC}[44mfill{ESC}[K{ESC}[0m\r\n"));
    feed.write(&numbered(0, 30));
    feed.close().await;
    assert_eq!(
        pane.harness.history.read(0, 2).await,
        vec![
            "plain   ".to_string(),
            format!("{ESC}[0m{ESC}[48;5;4mfill{}{ESC}[0m", " ".repeat(16)),
        ]
    );
}

#[tokio::test]
async fn keeps_colours_and_joins_soft_wrapped_rows_into_one_line() {
    let pane = pane();
    let feed = pane.open(20, 24);
    feed.write(&format!("{ESC}[31mred{ESC}[0m {}\r\n", "w".repeat(50)));
    feed.write(&numbered(0, batch() + 40));
    feed.tail().await;
    let first = pane.harness.history.read(0, 1).await.remove(0);
    assert!(first.contains(&format!("{ESC}[0m{ESC}[38;5;1mred")));
    assert_eq!(strip_vt(&first), format!("red {}", "w".repeat(50)));
}

#[tokio::test]
async fn records_where_each_command_block_starts_and_ends() {
    let pane = pane();
    let feed = pane.open(80, 24);
    feed.write(&format!(
        "{}$ {ESC}]633;E;make\x07{}make\r\n{}",
        mark("A"),
        mark("B"),
        mark("C")
    ));
    feed.write(&numbered(0, 3));
    feed.write(&format!("{}{}$ ", mark("D;2"), mark("A")));
    feed.write(&numbered(3, batch() + 40));
    feed.tail().await;
    assert_eq!(
        pane.harness.history.block(1),
        Some(HistoryBlock {
            seq: 1,
            start: 1,
            end: Some(4),
            end_col: 0,
            exit_code: Some(2),
            command: Some("make".to_string()),
        })
    );
}

#[tokio::test]
async fn wipes_the_history_when_the_program_clears_the_scrollback() {
    let pane = pane();
    let feed = pane.open(80, 24);
    feed.write(&numbered(0, 3000));
    feed.tail().await;
    assert!(pane.harness.history.end() - pane.harness.history.first() > 0);
    feed.write(&format!("{ESC}[H{ESC}[2J{ESC}[3J"));
    feed.write(&numbered(5000, 5));
    feed.close().await;
    assert_eq!(plain(&pane.harness.history).await, numbered_lines(5000, 5));
}

#[tokio::test]
async fn does_not_spill_a_restored_screen_twice_when_the_pane_already_has_history() {
    let pane = pane();
    let first = pane.open(80, 24);
    first.write(&numbered(0, 30));
    first.close().await;
    assert_eq!(pane.harness.history.end(), 30);
    let second = pane.open(80, 24);
    second.restore(numbered(0, 30).trim_end());
    second.write(&numbered(30, 5));
    second.close().await;
    assert_eq!(plain(&pane.harness.history).await, numbered_lines(0, 35));
}

#[tokio::test]
async fn marks_lines_it_lost_instead_of_skipping_them_silently() {
    let pane = pane();
    let feed = pane.open(10, 5);
    feed.write(&"x".repeat(10 * 60000));
    feed.write("\r\nend\r\n");
    feed.close().await;
    let lines = plain(&pane.harness.history).await;
    assert!(lines.contains(&strip_vt(GAP_LINE)));
    assert_eq!(lines.last().map(String::as_str), Some("end"));
}

#[tokio::test]
async fn carries_the_block_count_over_to_the_next_shell_of_the_pane() {
    let pane = pane();
    let first = pane.open(80, 24);
    first.write(&format!("{}{}{}", mark("C"), mark("D;0"), mark("C")));
    first.close().await;
    assert_eq!(pane.open(80, 24).seq_base(), 2);
    assert_eq!(pane.harness.history.seq_offset(), 2);
}

#[tokio::test]
async fn tails_the_normal_screen_it_left_while_a_full_screen_program_runs() {
    let pane = pane();
    let feed = pane.open(80, 24);
    feed.write(&numbered(0, 30));
    feed.tail().await;
    feed.write(&format!("{ESC}[?1049hALTERNATE"));
    let tail: Vec<String> = feed.tail().await.iter().map(|l| strip_vt(l)).collect();
    assert_eq!(tail, numbered_lines(0, 30));
    feed.write(&format!("{ESC}[?1049l"));
    let back: Vec<String> = feed.tail().await.iter().map(|l| strip_vt(l)).collect();
    assert_eq!(back, numbered_lines(0, 30));
}
