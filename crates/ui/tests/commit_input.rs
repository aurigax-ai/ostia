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

struct Case<'a> {
    cx: &'a mut TestAppContext,
    handle: AnyWindowHandle,
    view: Entity<Harness>,
    log: Rc<RefCell<Log>>,
}

impl<'a> Case<'a> {
    fn text(cx: &'a mut TestAppContext, saved: &'static str) -> Self {
        let log = Rc::new(RefCell::new(Log::default()));
        let setup_log = log.clone();
        let (handle, view) = open(cx, move |window, cx| {
            Harness::text(saved, &setup_log, window, cx)
        });
        Self {
            cx,
            handle,
            view,
            log,
        }
    }

    fn number(cx: &'a mut TestAppContext, min: Option<f64>, max: Option<f64>) -> Self {
        let log = Rc::new(RefCell::new(Log::default()));
        let setup_log = log.clone();
        let (handle, view) = open(cx, move |window, cx| {
            Harness::number(min, max, &setup_log, window, cx)
        });
        Self {
            cx,
            handle,
            view,
            log,
        }
    }

    fn step<R>(&mut self, run: impl FnOnce(&Entity<Harness>, &mut Window, &mut App) -> R) -> R {
        let view = self.view.clone();
        self.cx
            .update_window(self.handle, |_, window, cx| run(&view, window, cx))
            .expect("window update")
    }

    fn focus(&mut self) {
        self.step(focus_field);
    }

    fn leave(&mut self) {
        self.step(leave_field);
        self.step(|_, window, cx| window.render_frame(cx));
    }

    fn press(&mut self, key: &'static str) {
        self.step(|_, window, cx| window.press(key, cx));
    }

    fn type_over(&mut self, erase: usize, text: &'static str) {
        self.step(|_, window, cx| retype(window, erase, text, cx));
    }

    fn click(&mut self, id: &'static str) {
        self.step(|_, window, cx| {
            window.click(id, cx);
            window.render_frame(cx);
        });
    }

    fn field(&mut self) -> String {
        self.step(|view, _, cx| field_text(view, cx))
    }

    fn bad(&mut self) -> bool {
        self.step(|view, _, cx| view.read(cx).bad)
    }

    fn focused(&mut self) -> Option<bool> {
        self.step(|_, window, _| window.find_by_label(LABEL).focused())
    }

    fn commits(&self) -> Vec<String> {
        self.log.borrow().commits.clone()
    }

    fn numbers(&self) -> Vec<f64> {
        self.log.borrow().numbers.clone()
    }

    fn cancels(&self) -> u32 {
        self.log.borrow().cancels
    }
}

#[gpui_kit::test]
fn does_not_commit_while_typing_commits_on_blur(cx: &mut TestAppContext) {
    let mut case = Case::text(cx, "a");
    case.focus();
    case.type_over(0, "b");
    assert!(case.commits().is_empty());
    case.leave();
    assert_eq!(case.commits(), ["ab"]);
}

#[gpui_kit::test]
fn commits_on_enter(cx: &mut TestAppContext) {
    let mut case = Case::text(cx, "a");
    case.focus();
    case.type_over(0, "b");
    case.press("enter");
    assert_eq!(case.commits(), ["ab"]);
}

#[gpui_kit::test]
fn escape_restores_the_saved_value_and_commits_nothing(cx: &mut TestAppContext) {
    let mut case = Case::text(cx, "a");
    case.focus();
    case.type_over(0, "b");
    case.press("escape");
    assert_eq!(case.field(), "a");
    case.leave();
    assert!(case.commits().is_empty());
    assert_eq!(case.cancels(), 1);
}

#[gpui_kit::test]
fn keeps_the_draft_when_the_commit_is_rejected(cx: &mut TestAppContext) {
    let mut case = Case::text(cx, "a");
    case.focus();
    case.type_over(1, "bad");
    case.leave();
    assert_eq!(case.field(), "bad");
}

#[gpui_kit::test]
fn clears_the_error_when_the_saved_value_is_retyped(cx: &mut TestAppContext) {
    let mut case = Case::text(cx, "ok");
    case.focus();
    case.type_over(2, "bad");
    case.leave();
    assert!(case.bad());
    case.focus();
    case.type_over(3, "ok");
    case.leave();
    assert!(!case.bad());
    assert_eq!(case.cancels(), 1);
}

#[gpui_kit::test]
fn keeps_focus_on_the_same_input_after_enter_commits_a_new_value(cx: &mut TestAppContext) {
    let mut case = Case::text(cx, "ok");
    case.focus();
    case.type_over(2, "next");
    case.press("enter");
    case.step(|_, window, cx| window.render_frame(cx));
    assert_eq!(case.focused(), Some(true));
    assert_eq!(case.field(), "next");
}

#[gpui_kit::test]
fn drops_a_draft_when_the_saved_value_changes_elsewhere(cx: &mut TestAppContext) {
    let mut case = Case::text(cx, "ok");
    case.focus();
    case.type_over(2, "bad");
    case.click(PRESET);
    assert_eq!(case.field(), PRESET);
    case.leave();
    assert!(case.commits().is_empty());
}

#[gpui_kit::test]
fn commits_a_clamped_number_on_blur_and_enter(cx: &mut TestAppContext) {
    let mut case = Case::number(cx, Some(1.), Some(10.));
    case.focus();
    case.type_over(1, "99");
    assert!(case.numbers().is_empty());
    case.leave();
    assert_eq!(case.numbers(), [10.]);
    case.focus();
    case.type_over(1, "3");
    case.press("enter");
    assert_eq!(case.numbers(), [10., 3.]);
}

#[gpui_kit::test]
fn reverts_an_empty_entry_and_escape_restores_the_saved_value(cx: &mut TestAppContext) {
    let mut case = Case::number(cx, None, None);
    case.focus();
    case.type_over(1, "");
    case.leave();
    assert!(case.numbers().is_empty());
    assert_eq!(case.field(), "5");
    case.focus();
    case.type_over(1, "8");
    case.press("escape");
    assert_eq!(case.field(), "5");
    assert!(case.numbers().is_empty());
}
