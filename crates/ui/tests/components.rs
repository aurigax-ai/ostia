#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::prelude::*;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Context, Render, TestAppContext, Window, WindowOptions, div};
use ostia_ui::components::{
    Button, ControlRow, Segmented, SegmentedOption, StatusLine, StatusTone, Switch, TextLink,
};

struct Harness {
    mode: &'static str,
    clicks: Rc<Cell<u32>>,
    checked: bool,
    dismissed: bool,
}

impl Render for Harness {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let clicks = self.clicks.clone();
        let weak = cx.entity().downgrade();
        let toggle = cx.listener(|this, checked: &bool, _, cx| {
            this.checked = *checked;
            cx.notify();
        });
        let dismiss = cx.listener(|this, _, _, cx| {
            this.dismissed = true;
            cx.notify();
        });
        let link_clicks = self.clicks.clone();
        div()
            .size_full()
            .child(
                Button::new("plain")
                    .label("Press")
                    .on_click(move |_, _, _| clicks.set(clicks.get() + 1)),
            )
            .child(
                TextLink::new("link", "Link")
                    .on_click(move |_, _, _| link_clicks.set(link_clicks.get() + 10)),
            )
            .child(
                ControlRow::new("Row")
                    .control(Switch::new("switch", "Row", self.checked).on_change(toggle)),
            )
            .child(Segmented::new(
                "segments",
                self.mode,
                vec![
                    SegmentedOption::new("one", "One"),
                    SegmentedOption::new("two", "Two"),
                ],
                move |value, _, cx| {
                    let value = *value;
                    let _ = weak.update(cx, |this, cx| {
                        this.mode = value;
                        cx.notify();
                    });
                },
            ))
            .when(!self.dismissed, |root| {
                root.child(
                    StatusLine::new(StatusTone::Muted, "Status")
                        .on_dismiss("dismiss", "Dismiss", dismiss),
                )
            })
    }
}

#[gpui_kit::test]
fn shared_components_answer_real_clicks(cx: &mut TestAppContext) {
    cx.update(ostia_ui::init);
    let clicks = Rc::new(Cell::new(0));
    let (handle, view) = cx.update(|cx| {
        let clicks = clicks.clone();
        gpui_kit::open_window(WindowOptions::default(), cx, move |_, cx| {
            cx.new(|_| Harness {
                mode: "one",
                clicks,
                checked: false,
                dismissed: false,
            })
        })
        .expect("window")
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("plain", cx);
        window.click("link", cx);
        window.click("switch", cx);
        window.click(gpui_kit::ElementId::NamedInteger("segments".into(), 1), cx);
        window.click("dismiss", cx);
        assert!(window.try_find("dismiss").is_none());
    })
    .expect("window update");
    assert_eq!(clicks.get(), 11);
    view.read_with(cx, |view, _| {
        assert!(view.checked);
        assert_eq!(view.mode, "two");
        assert!(view.dismissed);
    });
}
