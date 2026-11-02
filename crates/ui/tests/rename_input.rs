#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::prelude::*;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, Context, Entity, IntoElement, Render, TestAppContext, Window, WindowOptions,
    div,
};
use ostia_ui::components::RenameInput;

const LABEL: &str = "Rename tab";

type Done = Rc<RefCell<Vec<Option<String>>>>;

struct Host {
    input: Entity<RenameInput>,
}

impl Render for Host {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.input.clone())
    }
}

fn open(cx: &mut TestAppContext) -> (AnyWindowHandle, Done) {
    cx.update(ostia_ui::init);
    let done: Done = Rc::default();
    let sink = done.clone();
    let (handle, _) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, move |window, cx| {
            let input = cx.new(|cx| {
                RenameInput::new(
                    "Build",
                    LABEL,
                    move |name, _, _| sink.borrow_mut().push(name),
                    window,
                    cx,
                )
            });
            cx.new(|_| Host { input })
        })
        .expect("window")
    });
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .expect("window update");
    (handle.into(), done)
}

fn act(
    cx: &mut TestAppContext,
    handle: AnyWindowHandle,
    run: impl FnOnce(&mut Window, &mut gpui_kit::App),
) {
    cx.update_window(handle, |_, window, cx| {
        run(window, cx);
        window.render_frame(cx);
    })
    .expect("window update");
}

#[gpui_kit::test]
fn the_field_is_named_and_starts_focused_with_the_value_selected(cx: &mut TestAppContext) {
    let (handle, done) = open(cx);
    act(cx, handle, |window, cx| {
        window.find_by_label(LABEL);
        window.input("Deploy", cx);
        window.press("enter", cx);
    });
    assert_eq!(*done.borrow(), vec![Some("Deploy".to_string())]);
}

#[gpui_kit::test]
fn enter_commits_the_draft_once(cx: &mut TestAppContext) {
    let (handle, done) = open(cx);
    act(cx, handle, |window, cx| {
        window.press("enter", cx);
        window.press("enter", cx);
    });
    assert_eq!(*done.borrow(), vec![Some("Build".to_string())]);
}

#[gpui_kit::test]
fn escape_cancels_with_no_name(cx: &mut TestAppContext) {
    let (handle, done) = open(cx);
    act(cx, handle, |window, cx| {
        window.input("Other", cx);
        window.press("escape", cx);
    });
    assert_eq!(*done.borrow(), vec![None]);
}
