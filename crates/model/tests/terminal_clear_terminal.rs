#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::terminal::clear_terminal::{ClearTarget, FORM_FEED, clear_keeping_scrollback};

#[derive(Default)]
struct Recorder {
    alternate: bool,
    rows: usize,
    cursor_y: usize,
    log: Vec<String>,
}

impl ClearTarget for Recorder {
    fn rows(&self) -> usize {
        self.rows
    }

    fn is_alternate_screen(&self) -> bool {
        self.alternate
    }

    fn cursor_y(&self) -> usize {
        self.cursor_y
    }

    async fn write(&mut self, data: &str) {
        self.log.push(format!("write {data:?}"));
    }

    fn scroll_to_bottom(&mut self) {
        self.log.push("scroll_to_bottom".to_owned());
    }

    fn input(&mut self, data: &str, was_user_input: bool) {
        self.log.push(format!("input {data:?} {was_user_input}"));
    }
}

fn terminal() -> Recorder {
    Recorder {
        rows: 24,
        cursor_y: 2,
        ..Recorder::default()
    }
}

#[test]
fn form_feed_is_the_control_character() {
    assert_eq!(FORM_FEED, "\x0c");
}

#[tokio::test]
async fn does_nothing_and_reports_false_on_the_alternate_screen() {
    let mut term = terminal();
    term.alternate = true;

    assert!(!clear_keeping_scrollback(&mut term, true).await);
    assert!(term.log.is_empty());
}

#[tokio::test]
async fn pushes_the_screen_into_scrollback_then_scrolls_to_the_bottom() {
    let mut term = terminal();

    assert!(clear_keeping_scrollback(&mut term, false).await);
    assert_eq!(
        term.log,
        [
            format!("write {:?}", "\x1b[24;1H\n\n\n\x1b[H"),
            "scroll_to_bottom".to_owned(),
        ]
    );
}

#[tokio::test]
async fn sends_a_form_feed_as_user_input_after_the_scroll_when_at_a_prompt() {
    let mut term = terminal();

    assert!(clear_keeping_scrollback(&mut term, true).await);
    assert_eq!(
        term.log,
        [
            format!("write {:?}", "\x1b[24;1H\n\n\n\x1b[H"),
            "scroll_to_bottom".to_owned(),
            format!("input {:?} true", "\x0c"),
        ]
    );
}
