use gpui_kit::prelude::*;
use gpui_kit::{App, IntoElement, RenderOnce, SharedString, Window, div, px, transparent_black};

use crate::theme::UiTheme;
use crate::tokens::{SPACE_2, TextStep, UiText};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BadgeVariant {
    #[default]
    Default,
    Secondary,
    Destructive,
    Outline,
}

#[derive(IntoElement)]
pub struct Badge {
    label: SharedString,
    variant: BadgeVariant,
}

impl Badge {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            variant: BadgeVariant::Default,
        }
    }

    pub fn variant(mut self, variant: BadgeVariant) -> Self {
        self.variant = variant;
        self
    }
}

impl RenderOnce for Badge {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let (background, foreground, border) = match self.variant {
            BadgeVariant::Default => (t.brand, t.on_brand, transparent_black()),
            BadgeVariant::Secondary => (t.surface_2, t.fg, transparent_black()),
            BadgeVariant::Destructive => (t.attn_fg.opacity(0.2), t.attn_fg, transparent_black()),
            BadgeVariant::Outline => (transparent_black(), t.fg, t.line),
        };
        div()
            .flex()
            .flex_none()
            .h(px(20.))
            .items_center()
            .justify_center()
            .overflow_hidden()
            .whitespace_nowrap()
            .px(SPACE_2)
            .rounded(px(26.))
            .border_1()
            .border_color(border)
            .bg(background)
            .text_color(foreground)
            .ui_text(TextStep::Sm, cx)
            .ui_weight_medium(cx)
            .child(self.label)
    }
}
