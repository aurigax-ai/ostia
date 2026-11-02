#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use gpui_kit::prelude::*;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Context, ElementId, Render, TestAppContext, Window, WindowOptions, div};
use ostia_ui::components::{Checkbox, Radio, RadioOption};

struct Harness {
    checked: bool,
    locked_checked: bool,
    choice: Option<&'static str>,
}

impl Render for Harness {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let toggle = cx.listener(|this, checked: &bool, _, cx| {
            this.checked = *checked;
            cx.notify();
        });
        let locked = cx.listener(|this, checked: &bool, _, cx| {
            this.locked_checked = *checked;
            cx.notify();
        });
        let pick = cx.listener(|this, value: &&'static str, _, cx| {
            this.choice = Some(*value);
            cx.notify();
        });
        div()
            .size_full()
            .child(Checkbox::new("check", "Check", self.checked).on_change(toggle))
            .child(
                Checkbox::new("locked", "Locked", self.locked_checked)
                    .disabled(true)
                    .on_change(locked),
            )
            .child(Radio::new(
                "radios",
                self.choice,
                vec![
                    RadioOption::new("a", "A"),
                    RadioOption::new("b", "B"),
                    RadioOption::new("c", "C").disabled(true),
                ],
                move |value, window, cx| {
                    let value = *value;
                    pick(&value, window, cx);
                },
            ))
    }
}

#[gpui_kit::test]
fn checkbox_and_radio_follow_real_clicks(cx: &mut TestAppContext) {
    cx.update(ostia_ui::init);
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| {
            cx.new(|_| Harness {
                checked: false,
                locked_checked: false,
                choice: None,
            })
        })
        .expect("window")
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("check", cx);
        window.render_frame(cx);
        window.click("locked", cx);
        window.within("radios").click(ElementId::Integer(1), cx);
        window.render_frame(cx);
        window.within("radios").click(ElementId::Integer(2), cx);
    })
    .expect("window update");
    view.read_with(cx, |view, _| {
        assert!(view.checked);
        assert!(!view.locked_checked);
        assert_eq!(view.choice, Some("b"));
    });
    cx.update_window(handle, |_, window, cx| {
        window.click("check", cx);
    })
    .expect("window update");
    view.read_with(cx, |view, _| assert!(!view.checked));
}
