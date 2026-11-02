#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::component::input::InputState;
use gpui_kit::prelude::*;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, App, Context, Entity, Render, TestAppContext, Window, WindowOptions, div,
};
use ostia_ui::components::{Button, CommitInput, CommitInputState, Input};

const LABEL: &str = "t";
const PRESET: &str = "preset";

#[derive(Default)]
struct Log {
    commits: Vec<String>,
    numbers: Vec<f64>,
    cancels: u32,
}

struct Harness {
    saved: String,
    bad: bool,
    state: Entity<CommitInputState>,
    other: Entity<InputState>,
}

impl Harness {
    fn text(
        saved: &str,
        log: &Rc<RefCell<Log>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let weak = cx.weak_entity();
        let commit_log = log.clone();
        let commit_weak = weak.clone();
        let state = CommitInputState::new(
            saved.to_owned(),
            move |text, _, cx| {
                commit_log.borrow_mut().commits.push(text.to_owned());
                let accepted = text != "bad";
                let _ = commit_weak.update(cx, |harness, cx| {
                    harness.bad = !accepted;
                    if accepted {
                        harness.saved = text.to_owned();
                    }
                    cx.notify();
                });
                accepted
            },
            window,
            cx,
        );
        let cancel_log = log.clone();
        state.update(cx, |state, _| {
            state.on_cancel(move |_, cx| {
                cancel_log.borrow_mut().cancels += 1;
                let _ = weak.update(cx, |harness, cx| {
                    harness.bad = false;
                    cx.notify();
                });
            });
        });
        Self::finish(saved, state, window, cx)
    }

    fn number(
        min: Option<f64>,
        max: Option<f64>,
        log: &Rc<RefCell<Log>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let log = log.clone();
        let state = CommitInputState::number(
            5.,
            min,
            max,
            move |number, _, _| log.borrow_mut().numbers.push(number),
            window,
            cx,
        );
        Self::finish("5", state, window, cx)
    }

    fn finish(
        saved: &str,
        state: Entity<CommitInputState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            saved: saved.to_owned(),
            bad: false,
            state,
            other: cx.new(|cx| InputState::new(window, cx)),
        }
    }
}

impl Render for Harness {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let preset = cx.listener(|harness, _, _, cx| {
            harness.saved = PRESET.to_owned();
            cx.notify();
        });
        div()
            .size_full()
            .child(CommitInput::new(&self.state, LABEL, self.saved.clone()).invalid(self.bad))
            .child(Input::new(&self.other, "other"))
            .child(Button::new(PRESET).label(PRESET).on_click(preset))
    }
}

fn open(
    cx: &mut TestAppContext,
    make: impl FnOnce(&mut Window, &mut Context<Harness>) -> Harness + 'static,
) -> (AnyWindowHandle, Entity<Harness>) {
    cx.update(ostia_ui::init);
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, move |window, cx| {
            cx.new(|cx| make(window, cx))
        })
        .expect("window")
    });
    (handle, view)
}

fn focus_field(view: &Entity<Harness>, window: &mut Window, cx: &mut App) {
    window.render_frame(cx);
    let input = view.read(cx).state.read(cx).input().clone();
    input.update(cx, |input, cx| input.focus(window, cx));
    window.render_frame(cx);
    window.press("end", cx);
}

fn leave_field(view: &Entity<Harness>, window: &mut Window, cx: &mut App) {
    let other = view.read(cx).other.clone();
    other.update(cx, |input, cx| input.focus(window, cx));
    window.render_frame(cx);
}

fn retype(window: &mut Window, erase: usize, text: &str, cx: &mut App) {
    for _ in 0..erase {
        window.press("backspace", cx);
    }
    window.input(text, cx);
}

fn field_text(view: &Entity<Harness>, cx: &App) -> String {
    view.read(cx)
        .state
        .read(cx)
        .input()
        .read(cx)
        .value()
        .to_string()
}

fn text_case(
    cx: &mut TestAppContext,
    saved: &'static str,
    run: impl FnOnce(&Entity<Harness>, &Rc<RefCell<Log>>, &mut Window, &mut App),
) {
    let log = Rc::new(RefCell::new(Log::default()));
    let setup_log = log.clone();
    let (handle, view) = open(cx, move |window, cx| {
        Harness::text(saved, &setup_log, window, cx)
    });
    cx.update_window(handle, |_, window, cx| run(&view, &log, window, cx))
        .expect("window update");
}

fn number_case(
    cx: &mut TestAppContext,
    min: Option<f64>,
    max: Option<f64>,
    run: impl FnOnce(&Entity<Harness>, &Rc<RefCell<Log>>, &mut Window, &mut App),
) {
    let log = Rc::new(RefCell::new(Log::default()));
    let setup_log = log.clone();
    let (handle, view) = open(cx, move |window, cx| {
        Harness::number(min, max, &setup_log, window, cx)
    });
    cx.update_window(handle, |_, window, cx| run(&view, &log, window, cx))
        .expect("window update");
}

#[gpui_kit::test]
fn does_not_commit_while_typing_commits_on_blur(cx: &mut TestAppContext) {
    text_case(cx, "a", |view, log, window, cx| {
        focus_field(view, window, cx);
        window.input("b", cx);
        assert!(log.borrow().commits.is_empty());
        leave_field(view, window, cx);
        assert_eq!(log.borrow().commits, ["ab"]);
    });
}

#[gpui_kit::test]
fn commits_on_enter(cx: &mut TestAppContext) {
    text_case(cx, "a", |view, log, window, cx| {
        focus_field(view, window, cx);
        window.input("b", cx);
        window.press("enter", cx);
        assert_eq!(log.borrow().commits, ["ab"]);
    });
}

#[gpui_kit::test]
fn escape_restores_the_saved_value_and_commits_nothing(cx: &mut TestAppContext) {
    text_case(cx, "a", |view, log, window, cx| {
        focus_field(view, window, cx);
        window.input("b", cx);
        window.press("escape", cx);
        assert_eq!(field_text(view, cx), "a");
        leave_field(view, window, cx);
        assert!(log.borrow().commits.is_empty());
        assert_eq!(log.borrow().cancels, 1);
    });
}

#[gpui_kit::test]
fn keeps_the_draft_when_the_commit_is_rejected(cx: &mut TestAppContext) {
    text_case(cx, "a", |view, _, window, cx| {
        focus_field(view, window, cx);
        retype(window, 1, "bad", cx);
        leave_field(view, window, cx);
        assert_eq!(field_text(view, cx), "bad");
    });
}

#[gpui_kit::test]
fn clears_the_error_when_the_saved_value_is_retyped(cx: &mut TestAppContext) {
    text_case(cx, "ok", |view, log, window, cx| {
        focus_field(view, window, cx);
        retype(window, 2, "bad", cx);
        leave_field(view, window, cx);
        assert!(view.read(cx).bad);
        focus_field(view, window, cx);
        retype(window, 3, "ok", cx);
        leave_field(view, window, cx);
        assert!(!view.read(cx).bad);
        assert_eq!(log.borrow().cancels, 1);
    });
}

#[gpui_kit::test]
fn keeps_focus_on_the_same_input_after_enter_commits_a_new_value(cx: &mut TestAppContext) {
    text_case(cx, "ok", |view, _, window, cx| {
        focus_field(view, window, cx);
        retype(window, 2, "next", cx);
        window.press("enter", cx);
        window.render_frame(cx);
        assert_eq!(window.find_by_label(LABEL).focused(), Some(true));
        assert_eq!(field_text(view, cx), "next");
    });
}

#[gpui_kit::test]
fn drops_a_draft_when_the_saved_value_changes_elsewhere(cx: &mut TestAppContext) {
    text_case(cx, "ok", |view, log, window, cx| {
        focus_field(view, window, cx);
        retype(window, 2, "bad", cx);
        window.click(PRESET, cx);
        window.render_frame(cx);
        assert_eq!(field_text(view, cx), PRESET);
        leave_field(view, window, cx);
        assert!(log.borrow().commits.is_empty());
    });
}

#[gpui_kit::test]
fn commits_a_clamped_number_on_blur_and_enter(cx: &mut TestAppContext) {
    number_case(cx, Some(1.), Some(10.), |view, log, window, cx| {
        focus_field(view, window, cx);
        retype(window, 1, "99", cx);
        assert!(log.borrow().numbers.is_empty());
        leave_field(view, window, cx);
        assert_eq!(log.borrow().numbers, [10.]);
        focus_field(view, window, cx);
        retype(window, 1, "3", cx);
        window.press("enter", cx);
        assert_eq!(log.borrow().numbers, [10., 3.]);
    });
}

#[gpui_kit::test]
fn reverts_an_empty_entry_and_escape_restores_the_saved_value(cx: &mut TestAppContext) {
    number_case(cx, None, None, |view, log, window, cx| {
        focus_field(view, window, cx);
        retype(window, 1, "", cx);
        leave_field(view, window, cx);
        assert!(log.borrow().numbers.is_empty());
        assert_eq!(field_text(view, cx), "5");
        focus_field(view, window, cx);
        retype(window, 1, "8", cx);
        window.press("escape", cx);
        assert_eq!(field_text(view, cx), "5");
        assert!(log.borrow().numbers.is_empty());
    });
}
