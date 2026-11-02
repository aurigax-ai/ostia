use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, Hsla, IntoElement, RenderOnce, SharedString, Window, div, px};

use crate::icons::{IconName, IconSize, icon};
use crate::theme::UiTheme;
use crate::tokens::{SPACE_1, SPACE_2, TextStep, UiText};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NoticeTone {
    #[default]
    Warn,
    Error,
    Info,
}

impl NoticeTone {
    fn icon(self) -> IconName {
        match self {
            Self::Warn => IconName::Warning,
            Self::Error => IconName::WarningCircle,
            Self::Info => IconName::Info,
        }
    }

    fn color(self, cx: &App) -> Hsla {
        let t = cx.tokens();
        match self {
            Self::Warn => t.warn_fg,
            Self::Error => t.attn_fg,
            Self::Info => t.fg_muted,
        }
    }
}

#[derive(IntoElement)]
pub struct Notice {
    tone: NoticeTone,
    text: SharedString,
    actions: Vec<AnyElement>,
}

impl Notice {
    pub fn new(tone: NoticeTone, text: impl Into<SharedString>) -> Self {
        Self {
            tone,
            text: text.into(),
            actions: Vec::new(),
        }
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

impl RenderOnce for Notice {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let color = self.tone.color(cx);
        div()
            .flex()
            .items_center()
            .gap(SPACE_2)
            .mt(SPACE_1)
            .text_color(color)
            .ui_text(TextStep::Sm, cx)
            .child(icon(self.tone.icon(), IconSize::Standard, color))
            .child(div().flex_1().min_w_0().child(self.text))
            .when(!self.actions.is_empty(), |row| {
                row.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(4.))
                        .children(self.actions),
                )
            })
    }
}
