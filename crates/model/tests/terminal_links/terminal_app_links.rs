#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use ostia_model::settings::terminal_pane_settings::LinkClick;
use ostia_model::terminal::ostia_terminal::{TerminalPosition, TerminalRange};
use ostia_model::terminal_links::link_modifier::{
    TerminalLinkTarget, WebLinkClick, WebLinkClickContext, WebLinkTarget, terminal_link_target,
};
use ostia_model::terminal_links::terminal_app_links::{
    AppLink, HintSink, LinkEvent, WebLinkHandler, create_app_link_provider, hinted_link_handler,
};
use ostia_model::terminal_links::terminal_file_links::{BufferCell, BufferRow, TerminalBuffer};

const VAULT: &str = "obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中文.md&newpane=true";

struct Screen(Vec<BufferRow>);

impl TerminalBuffer for Screen {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn line(&self, y: usize) -> Option<BufferRow> {
        self.0.get(y).cloned()
    }
}

fn is_wide(ch: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&ch)
}

fn screen(cols: usize, text: &str) -> Arc<Screen> {
    let mut rows: Vec<BufferRow> = Vec::new();
    let mut current = BufferRow {
        wrapped: false,
        cells: Vec::new(),
    };
    let mut x = 0;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' && chars.peek() == Some(&'\n') {
            chars.next();
            rows.push(current);
            current = BufferRow {
                wrapped: false,
                cells: Vec::new(),
            };
            x = 0;
            continue;
        }
        let width: u8 = if is_wide(ch) { 2 } else { 1 };
        if x + usize::from(width) > cols {
            rows.push(current);
            current = BufferRow {
                wrapped: true,
                cells: Vec::new(),
            };
            x = 0;
        }
        current.cells.push(BufferCell {
            chars: ch.to_string(),
            width,
        });
        if width == 2 {
            current.cells.push(BufferCell {
                chars: String::new(),
                width: 0,
            });
        }
        x += usize::from(width);
    }
    rows.push(current);
    Arc::new(Screen(rows))
}

type Call = (LinkEvent, String, TerminalRange);

#[derive(Default)]
struct Spy {
    activated: Mutex<Vec<Call>>,
    hovered: Mutex<Vec<Call>>,
    left: Mutex<Vec<Call>>,
}

impl WebLinkHandler for Spy {
    fn activate(&self, event: LinkEvent, uri: &str, range: TerminalRange) {
        self.activated
            .lock()
            .unwrap()
            .push((event, uri.to_owned(), range));
    }

    fn hover(&self, event: LinkEvent, uri: &str, range: TerminalRange) {
        self.hovered
            .lock()
            .unwrap()
            .push((event, uri.to_owned(), range));
    }

    fn leave(&self, event: LinkEvent, uri: &str, range: TerminalRange) {
        self.left
            .lock()
            .unwrap()
            .push((event, uri.to_owned(), range));
    }
}

#[derive(Default)]
struct Hint {
    shown: Mutex<Vec<(TerminalRange, String)>>,
    hidden: Mutex<usize>,
}

impl HintSink for Hint {
    fn show(&self, range: TerminalRange, uri: &str) {
        self.shown.lock().unwrap().push((range, uri.to_owned()));
    }

    fn hide(&self) {
        *self.hidden.lock().unwrap() += 1;
    }
}

fn texts(links: &Option<Vec<AppLink>>) -> Vec<&str> {
    links
        .iter()
        .flatten()
        .map(|link| link.text.as_str())
        .collect()
}

fn pos(x: i64, y: i64) -> TerminalPosition {
    TerminalPosition { x, y }
}

fn click() -> LinkEvent {
    LinkEvent::default()
}

#[test]
fn links_a_wrapped_angle_bracket_target_with_spaces_and_wide_characters() {
    let term = screen(40, &format!("see [中文](<{VAULT}>) ok"));
    let spy = Arc::new(Spy::default());
    let provider = create_app_link_provider(term, spy.clone());
    for row in [1, 2, 3] {
        assert_eq!(texts(&provider.provide_links(row)), [VAULT], "row {row}");
    }
    let links = provider.provide_links(1).unwrap();
    let link = &links[0];
    assert_eq!(link.range.start, pos(13, 1));
    assert_eq!(link.range.end.y, 3);
    link.activate(click());
    assert_eq!(
        *spy.activated.lock().unwrap(),
        [(click(), VAULT.to_owned(), link.range)]
    );
}

#[test]
fn links_plain_vscode_links_and_skips_web_and_script_links() {
    let term = screen(
        80,
        "vscode://file/a.ts:3 https://example.com javascript://x",
    );
    let provider = create_app_link_provider(term, Arc::new(Spy::default()));
    assert_eq!(texts(&provider.provide_links(1)), ["vscode://file/a.ts:3"]);
}

#[test]
fn links_plain_and_angle_bracket_links_of_any_scheme_and_skips_blocked_ones() {
    let term = screen(
        120,
        "slack://channel?id=1 [z](<zed://file/My Dir/a>) devtools://x foo::bar smb://h/s ms-msdt://i postgres://u:p@h/db",
    );
    let provider = create_app_link_provider(term, Arc::new(Spy::default()));
    assert_eq!(
        texts(&provider.provide_links(1)),
        ["slack://channel?id=1", "zed://file/My Dir/a"]
    );
}

#[test]
fn hands_the_hint_the_full_target_of_a_detected_app_link() {
    let term = screen(40, &format!("see [中文](<{VAULT}>) ok"));
    let hint = Arc::new(Hint::default());
    let handler = hinted_link_handler(Box::new(|_, _, _| {}), hint.clone());
    let provider = create_app_link_provider(term, handler);
    let links = provider.provide_links(2).unwrap();
    let link = &links[0];
    link.hover(click());
    assert_eq!(
        *hint.shown.lock().unwrap(),
        [(link.range, VAULT.to_owned())]
    );
}

#[test]
fn shows_no_hint_for_a_link_it_would_not_open() {
    let hint = Arc::new(Hint::default());
    let range = TerminalRange {
        start: pos(1, 1),
        end: pos(4, 1),
    };
    hinted_link_handler(Box::new(|_, _, _| {}), hint.clone()).hover(click(), "javascript:x", range);
    assert!(hint.shown.lock().unwrap().is_empty());
}

#[test]
fn hides_the_hint_when_the_pointer_leaves_a_link() {
    let hint = Arc::new(Hint::default());
    let range = TerminalRange {
        start: pos(1, 1),
        end: pos(4, 1),
    };
    let handler = hinted_link_handler(Box::new(|_, _, _| {}), hint.clone());
    handler.leave(click(), "vscode://file/a", range);
    assert_eq!(*hint.hidden.lock().unwrap(), 1);
}

#[test]
fn hands_a_click_on_to_the_activate_function_it_was_given() {
    let seen: Arc<Mutex<Vec<Call>>> = Arc::default();
    let sink = seen.clone();
    let handler = hinted_link_handler(
        Box::new(move |event, uri, range| {
            sink.lock().unwrap().push((event, uri.to_owned(), range));
        }),
        Arc::new(Hint::default()),
    );
    let range = TerminalRange {
        start: pos(1, 1),
        end: pos(4, 1),
    };
    handler.activate(click(), "vscode://file/a", range);
    assert_eq!(
        *seen.lock().unwrap(),
        [(click(), "vscode://file/a".to_owned(), range)]
    );
}

#[test]
fn offers_no_links_on_a_row_without_an_app_link() {
    let term = screen(80, "just text and https://example.com");
    let provider = create_app_link_provider(term, Arc::new(Spy::default()));
    assert!(provider.provide_links(1).is_none());
}

mod claude_code_forms {
    use super::*;

    const A: &str = VAULT;
    const B: &str = "obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=05%20Projects/%E4%B8%AD.md";
    const C: &str = "obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=a.md";
    const D: &str = "https://gitlab.fism.app";

    fn lines_of(lines: &[String]) -> Vec<Vec<String>> {
        let term = screen(200, &lines.join("\r\n"));
        let provider = create_app_link_provider(term, Arc::new(Spy::default()));
        (1..=i64::try_from(lines.len()).unwrap())
            .map(|row| {
                provider
                    .provide_links(row)
                    .iter()
                    .flatten()
                    .map(|link| link.text.clone())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn shows_the_raw_markdown_forms_as_links_when_a_program_prints_them_unrendered() {
        let raw = [
            format!("[A](<{A}>)"),
            format!("[B]({B})"),
            C.to_owned(),
            format!("[GitLab]({D})"),
        ];
        assert_eq!(
            lines_of(&raw),
            [
                vec![A.to_owned()],
                vec![B.to_owned()],
                vec![C.to_owned()],
                vec![]
            ]
        );
    }

    #[test]
    fn opens_a_b_and_c_in_their_app_and_d_in_the_browser_on_a_plain_click() {
        let plain = WebLinkClick {
            ctrl: false,
            meta: false,
            shift: false,
            detail: 1,
        };
        let ctx = WebLinkClickContext {
            mac: true,
            has_selection: false,
            mouse_reporting: false,
            link_click: LinkClick::App,
        };
        let targets: Vec<_> = [A, B, C, D]
            .iter()
            .map(|uri| terminal_link_target(uri, plain, ctx))
            .collect();
        assert_eq!(
            targets,
            [
                Some(TerminalLinkTarget::App),
                Some(TerminalLinkTarget::App),
                Some(TerminalLinkTarget::App),
                Some(TerminalLinkTarget::Web(WebLinkTarget::SameTab)),
            ]
        );
    }
}
