#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate gpui_kit as gpui;

use gpui_kit::prelude::*;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    App, AppContext as _, Context, IntoElement, Render, RenderOnce, TestAppContext, Window,
    WindowOptions, div,
};
use ostia_ui::components::{Button, ButtonSize, ButtonVariant, IconName};

const RESET_ZOOM: &str = "Reset zoom to 100%";
const CHIP_ID: &str = "zoom-chip";

#[derive(IntoElement)]
struct ZoomChip {
    percent: Option<u32>,
    on_reset: Box<dyn Fn(&mut Window, &mut App)>,
}

impl RenderOnce for ZoomChip {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let on_reset = self.on_reset;
        div().children(self.percent.map(|percent| {
            let icon = if percent < 100 {
                IconName::MagnifyingGlassMinus
            } else {
                IconName::MagnifyingGlassPlus
            };
            Button::new(CHIP_ID)
                .icon(icon)
                .label(format!("{percent}%"))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .tooltip(RESET_ZOOM)
                .on_click(move |_, window, cx| on_reset(window, cx))
        }))
    }
}

struct Harness {
    percent: Option<u32>,
}

impl Render for Harness {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let weak = cx.entity().downgrade();
        ZoomChip {
            percent: self.percent,
            on_reset: Box::new(move |_, cx| {
                let _ = weak.update(cx, |harness, cx| {
                    harness.percent = None;
                    cx.notify();
                });
            }),
        }
    }
}

#[gpui_kit::test]
fn shows_nothing_at_the_normal_size(cx: &mut TestAppContext) {
    cx.update(ostia_ui::init);
    let (handle, _) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| {
            cx.new(|_| Harness { percent: None })
        })
        .expect("window")
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find(CHIP_ID).is_none());
    })
    .expect("window update");
}

#[gpui_kit::test]
fn shows_the_scale_and_goes_back_on_click(cx: &mut TestAppContext) {
    cx.update(ostia_ui::init);
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| {
            cx.new(|_| Harness { percent: Some(110) })
        })
        .expect("window")
    });
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find(CHIP_ID).is_some());
        window.click(CHIP_ID, cx);
        assert!(window.try_find(CHIP_ID).is_none());
    })
    .expect("window update");
    view.read_with(cx, |view, _| assert_eq!(view.percent, None));
}
