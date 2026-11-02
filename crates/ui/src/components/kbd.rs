use gpui_kit::prelude::*;
use gpui_kit::{App, IntoElement, RenderOnce, SharedString, Window, div, px};

use crate::theme::UiTheme;
use crate::tokens::{RADIUS_SM, SPACE_1, TextStep, UiText};

#[derive(IntoElement)]
pub struct Kbd {
    keys: SharedString,
    bare: bool,
}

impl Kbd {
    pub fn new(keys: impl Into<SharedString>) -> Self {
        Self {
            keys: keys.into(),
            bare: false,
        }
    }

    pub fn bare(mut self) -> Self {
        self.bare = true;
        self
    }
}

impl RenderOnce for Kbd {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        div()
            .flex()
            .flex_none()
            .h(if self.bare { px(16.) } else { px(20.) })
            .min_w(px(20.))
            .items_center()
            .justify_center()
            .whitespace_nowrap()
            .px(SPACE_1)
            .rounded(RADIUS_SM)
            .when(!self.bare, |kbd| kbd.bg(t.surface_2))
            .text_color(t.fg_muted)
            .ui_text(TextStep::Sm, cx)
            .ui_weight_medium(cx)
            .child(self.keys)
    }
}
