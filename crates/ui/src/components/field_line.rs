use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, px};

use crate::theme::UiTheme;
use crate::tokens::{SPACE_3, TextStep, UiText};

const ROW_PADDING_Y: f32 = 6.;
const DESC_GAP: f32 = 2.;
const CONTROL_GAP: f32 = 6.;

#[derive(IntoElement)]
pub struct FieldLine {
    label: SharedString,
    desc: Option<SharedString>,
    children: Vec<AnyElement>,
}

impl FieldLine {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            desc: None,
            children: Vec::new(),
        }
    }

    pub fn desc(mut self, desc: impl Into<SharedString>) -> Self {
        self.desc = Some(desc.into());
        self
    }

    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.children.push(child.into_any_element());
        self
    }
}

impl RenderOnce for FieldLine {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        div()
            .py(px(ROW_PADDING_Y))
            .child(
                div()
                    .text_color(t.fg)
                    .ui_text(TextStep::Base, cx)
                    .child(self.label),
            )
            .when_some(self.desc, |line, desc| {
                line.child(
                    div()
                        .mt(px(DESC_GAP))
                        .text_color(t.fg_muted)
                        .ui_text(TextStep::Sm, cx)
                        .child(desc),
                )
            })
            .child(
                div()
                    .mt(px(CONTROL_GAP))
                    .flex()
                    .flex_wrap()
                    .items_start()
                    .gap(SPACE_3)
                    .children(self.children),
            )
    }
}
