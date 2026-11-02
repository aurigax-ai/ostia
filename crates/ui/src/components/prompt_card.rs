use std::rc::Rc;

use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, Hsla, IntoElement, RenderOnce, SharedString, Window, div, px};

use super::button::ClickHandler;
use super::icon_button::IconButton;
use crate::icons::{IconName, IconSize, icon};
use crate::theme::UiTheme;
use crate::tokens::{PROMPT_CARD_MAX_W, RADIUS_LG, SPACE_2, SPACE_3, TextStep, UiText};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PromptTone {
    #[default]
    Muted,
    Warn,
    Error,
}

impl PromptTone {
    fn color(self, cx: &App) -> Hsla {
        let t = cx.tokens();
        match self {
            Self::Muted => t.fg_muted,
            Self::Warn => t.warn_fg,
            Self::Error => t.attn_fg,
        }
    }
}

#[derive(IntoElement)]
pub struct PromptCard {
    icon: IconName,
    tone: PromptTone,
    title: SharedString,
    body: Option<AnyElement>,
    actions: Vec<AnyElement>,
    dismiss_label: SharedString,
    on_dismiss: ClickHandler,
}

impl PromptCard {
    pub fn new(
        icon: IconName,
        title: impl Into<SharedString>,
        dismiss_label: impl Into<SharedString>,
        on_dismiss: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            icon,
            tone: PromptTone::Muted,
            title: title.into(),
            body: None,
            actions: Vec::new(),
            dismiss_label: dismiss_label.into(),
            on_dismiss: Rc::new(on_dismiss),
        }
    }

    pub fn tone(mut self, tone: PromptTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn body(mut self, body: impl IntoElement) -> Self {
        self.body = Some(body.into_any_element());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

impl RenderOnce for PromptCard {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let on_dismiss = self.on_dismiss;
        div()
            .absolute()
            .right(SPACE_3)
            .bottom(SPACE_3)
            .flex()
            .flex_col()
            .gap(SPACE_2)
            .max_w(PROMPT_CARD_MAX_W)
            .p(SPACE_3)
            .rounded(RADIUS_LG)
            .bg(t.surface_3)
            .border_1()
            .border_color(t.fg.opacity(0.1))
            .shadow_md()
            .occlude()
            .text_color(t.fg)
            .ui_text(TextStep::Sm, cx)
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(SPACE_2)
                    .child(div().flex_none().mt(px(2.)).child(icon(
                        self.icon,
                        IconSize::Standard,
                        self.tone.color(cx),
                    )))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(div().ui_weight_medium(cx).child(self.title))
                            .when_some(self.body, |text, body| {
                                text.child(div().text_color(t.fg_muted).child(body))
                            }),
                    )
                    .child(
                        IconButton::new("prompt-card-dismiss", IconName::X, self.dismiss_label)
                            .on_click(move |event, window, cx| on_dismiss(event, window, cx)),
                    ),
            )
            .when(!self.actions.is_empty(), |card| {
                card.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .justify_end()
                        .gap(SPACE_2)
                        .children(self.actions),
                )
            })
    }
}
