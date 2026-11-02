use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, px};

use super::kbd::Kbd;
use crate::theme::UiTheme;
use crate::tokens::{SPACE_3, TextStep, UiText};

#[derive(IntoElement)]
pub struct PaletteRow {
    name: SharedString,
    detail: Option<SharedString>,
    keys: Option<SharedString>,
    meta: Option<SharedString>,
    meta_is_code: bool,
    after: Option<AnyElement>,
}

impl PaletteRow {
    pub fn new(name: impl Into<SharedString>) -> Self {
        Self {
            name: name.into(),
            detail: None,
            keys: None,
            meta: None,
            meta_is_code: false,
            after: None,
        }
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn keys(mut self, keys: impl Into<SharedString>) -> Self {
        self.keys = Some(keys.into());
        self
    }

    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn meta_code(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self.meta_is_code = true;
        self
    }

    pub fn after(mut self, after: impl IntoElement) -> Self {
        self.after = Some(after.into_any_element());
        self
    }
}

impl RenderOnce for PaletteRow {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let secondary = |text: SharedString, cx: &App| {
            div()
                .min_w_0()
                .truncate()
                .text_color(t.fg_muted)
                .ui_text(TextStep::Xs, cx)
                .child(text)
        };
        let has_trailing = self.keys.is_some() || self.meta.is_some();
        div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap_x(SPACE_3)
            .ui_text(TextStep::Base, cx)
            .text_color(t.fg)
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .items_center()
                    .gap(px(8.))
                    .child(div().min_w_0().truncate().child(self.name))
                    .children(self.after),
            )
            .when_some(self.detail, |row, detail| row.child(secondary(detail, cx)))
            .when(has_trailing, |row| {
                row.child(
                    div()
                        .ml_auto()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap_x(SPACE_3)
                        .when_some(self.keys, |line, keys| line.child(Kbd::new(keys)))
                        .when_some(self.meta, |line, meta| {
                            line.child(
                                secondary(meta, cx)
                                    .when(self.meta_is_code, |meta| meta.font_code()),
                            )
                        }),
                )
            })
    }
}
