#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use std::rc::Rc;
use std::time::Duration;

use gpui_kit::prelude::*;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, Context, Entity, IntoElement, Render, TestAppContext, TestSupportExt as _,
    Window, WindowOptions, div,
};
use ostia_ui::components::{NoticeBuilder, NoticeSlot};
use ostia_ui::tokens::MOTION_BASE_EXIT;

const NOTE: &str = "note";

struct Host {
    slot: Entity<NoticeSlot>,
}

impl Render for Host {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.slot.clone())
    }
}

fn note() -> NoticeBuilder {
    Rc::new(|_, _| {
        div()
            .id(NOTE)
            .test_support()
            .child("note")
            .into_any_element()
    })
}

fn open(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<NoticeSlot>) {
    cx.update(ostia_ui::init);
    let (handle, host) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| {
            let slot = cx.new(|_| NoticeSlot::new());
            cx.new(|_| Host { slot })
        })
        .expect("window")
    });
    let slot = host.read_with(cx, |host, _| host.slot.clone());
    (handle, slot)
}

fn render(cx: &mut TestAppContext, handle: AnyWindowHandle) {
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .expect("window update");
}

fn found(cx: &mut TestAppContext, handle: AnyWindowHandle) -> bool {
    cx.update_window(handle, |_, window, _| window.try_find(NOTE).is_some())
        .expect("window update")
}

#[gpui_kit::test]
fn renders_nothing_while_there_is_no_notice(cx: &mut TestAppContext) {
    let (handle, slot) = open(cx);
    render(cx, handle);
    assert!(slot.read_with(cx, |slot, _| slot.is_empty()));
    assert!(!found(cx, handle));
}

#[gpui_kit::test]
fn keeps_the_last_notice_inert_until_its_exit_ends(cx: &mut TestAppContext) {
    let (handle, slot) = open(cx);
    slot.update(cx, |slot, cx| slot.show(note(), cx));
    render(cx, handle);
    assert!(found(cx, handle));
    assert!(!slot.read_with(cx, |slot, _| slot.is_leaving()));

    slot.update(cx, |slot, cx| slot.hide(cx));
    render(cx, handle);
    assert!(slot.read_with(cx, |slot, _| slot.is_leaving()));
    assert!(found(cx, handle));

    cx.executor().advance_clock(MOTION_BASE_EXIT / 2);
    cx.run_until_parked();
    render(cx, handle);
    assert!(slot.read_with(cx, |slot, _| slot.is_leaving()));

    cx.executor()
        .advance_clock(MOTION_BASE_EXIT + Duration::from_millis(1));
    cx.run_until_parked();
    render(cx, handle);
    assert!(slot.read_with(cx, |slot, _| slot.is_empty()));
    assert!(!found(cx, handle));
}

#[gpui_kit::test]
fn shows_a_notice_that_returns_mid_exit_straight_away_interactive_again(cx: &mut TestAppContext) {
    let (handle, slot) = open(cx);
    slot.update(cx, |slot, cx| slot.show(note(), cx));
    slot.update(cx, |slot, cx| slot.hide(cx));
    slot.update(cx, |slot, cx| slot.show(note(), cx));
    render(cx, handle);
    assert!(!slot.read_with(cx, |slot, _| slot.is_leaving()));
    assert!(found(cx, handle));

    cx.executor()
        .advance_clock(MOTION_BASE_EXIT + Duration::from_millis(1));
    cx.run_until_parked();
    render(cx, handle);
    assert!(!slot.read_with(cx, |slot, _| slot.is_empty()));
    assert!(found(cx, handle));
}
