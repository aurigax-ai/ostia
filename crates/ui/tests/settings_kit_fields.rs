#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use gpui_kit::prelude::*;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Context, Render, TestAppContext, Window, WindowOptions, div};
use ostia_ui::components::{Button, FieldLine, MachineValue};

const INSTALL_ID: &str = "92c5cc36-ec25-428e-99ec-6cc83cd729e6";
const INSTALL_ID_LABEL: &str = "Install id";
const INSTALL_ID_DESC: &str = "A random id that groups reports from this installation.";
const RESET_INSTALL_ID: &str = "Reset install id";
const VALUE_ID: &str = "install-id-value";
const RESET_ID: &str = "reset-install-id";

struct Harness {
    resets: u32,
}

impl Render for Harness {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let reset = cx.listener(|this, _, _, cx| {
            this.resets += 1;
            cx.notify();
        });
        div().size_full().child(
            FieldLine::new(INSTALL_ID_LABEL)
                .desc(INSTALL_ID_DESC)
                .child(MachineValue::new(VALUE_ID, INSTALL_ID).label(INSTALL_ID_LABEL))
                .child(
                    Button::new(RESET_ID)
                        .label(RESET_INSTALL_ID)
                        .on_click(reset),
                ),
        )
    }
}

#[gpui_kit::test]
fn field_line_holds_a_machine_value_and_its_controls(cx: &mut TestAppContext) {
    cx.update(ostia_ui::init);
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| {
            cx.new(|_| Harness { resets: 0 })
        })
        .expect("window")
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find(VALUE_ID).is_some());
        assert!(window.try_find(RESET_ID).is_some());
        window.click(RESET_ID, cx);
    })
    .expect("window update");
    view.read_with(cx, |view, _| assert_eq!(view.resets, 1));
}

#[gpui_kit::test]
fn machine_value_keeps_a_long_value_in_one_truncated_box(cx: &mut TestAppContext) {
    cx.update(ostia_ui::init);
    let (handle, _) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| {
            cx.new(|_| Harness { resets: 0 })
        })
        .expect("window")
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        let value = window.find(VALUE_ID);
        let reset = window.find(RESET_ID);
        assert_eq!(value.label(), Some(INSTALL_ID_LABEL));
        let value = value.bounds();
        let reset = reset.bounds();
        assert!(value.size.width <= window.viewport_size().width);
        assert!(value.right() <= reset.left() || value.bottom() <= reset.top());
    })
    .expect("window update");
}
