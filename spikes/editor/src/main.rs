use std::fs;
use std::time::Instant;

use gpui_kit::component::input::{Editor, EditorState};
use gpui_kit::*;
use similar::{ChangeTag, TextDiff};

struct SideBySide {
    left: Entity<EditorState>,
    right: Option<Entity<EditorState>>,
}

impl Render for SideBySide {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let offset = self.left.read(cx).scroll_offset();
        if let Some(right) = &self.right
            && right.read(cx).scroll_offset() != offset
        {
            right.update(cx, |state, cx| state.set_scroll_offset(offset, cx));
        }
        div()
            .flex()
            .size_full()
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .child(Editor::new(&self.left).h_full()),
            )
            .children(
                self.right
                    .as_ref()
                    .map(|right| div().flex_1().h_full().child(Editor::new(right).h_full())),
            )
    }
}

fn resident_kib() -> u64 {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("VmRSS:"))
                .and_then(|rest| rest.split_whitespace().next()?.parse().ok())
        })
        .unwrap_or(0)
}

fn changed_lines(left: &str, right: &str) -> (usize, usize) {
    let diff = TextDiff::from_lines(left, right);
    diff.iter_all_changes()
        .fold((0, 0), |(removed, added), change| match change.tag() {
            ChangeTag::Delete => (removed + 1, added),
            ChangeTag::Insert => (removed, added + 1),
            ChangeTag::Equal => (removed, added),
        })
}

fn main() {
    let mut args = std::env::args().skip(1);
    let left_path = args.next().expect("left file");
    let right_path = args.next().unwrap_or_else(|| left_path.clone());
    let language = args.next().unwrap_or_else(|| "typescript".to_string());
    let left_text = fs::read_to_string(&left_path).expect("read left");
    let right_text = fs::read_to_string(&right_path).expect("read right");

    let diff_started = Instant::now();
    let (removed, added) = changed_lines(&left_text, &right_text);
    eprintln!(
        "diff_ms={} removed={removed} added={added}",
        diff_started.elapsed().as_millis()
    );

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let rss_before = resident_kib();
        gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
            let started = Instant::now();
            let soft_wrap = std::env::var_os("SPIKE_NOWRAP").is_none();
            let single = std::env::var_os("SPIKE_SINGLE").is_some();
            let left = cx.new(|cx| {
                EditorState::new(window, cx)
                    .language(language.clone())
                    .soft_wrap(soft_wrap)
            });
            left.update(cx, |state, cx| {
                state.set_value(left_text.as_str(), window, cx)
            });
            let right = (!single).then(|| {
                let right = cx.new(|cx| {
                    EditorState::new(window, cx)
                        .language(language.clone())
                        .soft_wrap(soft_wrap)
                });
                right.update(cx, |state, cx| {
                    state.set_value(right_text.as_str(), window, cx)
                });
                right
            });
            eprintln!(
                "open_ms={} rss_delta_kib={}",
                started.elapsed().as_millis(),
                resident_kib().saturating_sub(rss_before)
            );
            cx.new(|_| SideBySide { left, right })
        })
        .expect("open window");
    });
}
