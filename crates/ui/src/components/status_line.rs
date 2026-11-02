use std::rc::Rc;

use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, ClickEvent, ElementId, Hsla, IntoElement, RenderOnce, SharedString, Window,
    div,
};

use super::button::{Button, ButtonSize, ButtonVariant, ClickHandler};
use super::icon_button::IconButton;
use crate::icons::{IconName, IconSize, icon};
use crate::theme::UiTheme;
use crate::tokens::{SPACE_2, SPACE_3, STATUS_LINE_H, TextStep, UiText};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StatusTone {
    #[default]
    Muted,
    Warn,
    Error,
}

impl StatusTone {
    fn icon(self) -> IconName {
        match self {
            Self::Muted => IconName::Info,
            Self::Warn => IconName::Warning,
            Self::Error => IconName::WarningCircle,
        }
    }

    fn color(self, cx: &App) -> Hsla {
        let t = cx.tokens();
        match self {
            Self::Muted => t.fg_muted,
            Self::Warn => t.warn_fg,
            Self::Error => t.attn_fg,
        }
    }
}

struct Dismiss {
    id: ElementId,
    label: SharedString,
    handler: ClickHandler,
}

#[derive(IntoElement)]
pub struct StatusLine {
    tone: StatusTone,
    text: SharedString,
    actions: Vec<AnyElement>,
    dismiss: Option<Dismiss>,
}

impl StatusLine {
    pub fn new(tone: StatusTone, text: impl Into<SharedString>) -> Self {
        Self {
            tone,
            text: text.into(),
            actions: Vec::new(),
            dismiss: None,
        }
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    pub fn on_dismiss(
        mut self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.dismiss = Some(Dismiss {
            id: id.into(),
            label: label.into(),
            handler: Rc::new(handler),
        });
        self
    }
}

impl RenderOnce for StatusLine {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        div()
            .flex()
            .flex_none()
            .w_full()
            .h(STATUS_LINE_H)
            .items_center()
            .gap(SPACE_2)
            .px(SPACE_3)
            .bg(t.surface_1)
            .text_color(t.fg)
            .ui_text(TextStep::Sm, cx)
            .child(icon(
                self.tone.icon(),
                IconSize::Standard,
                self.tone.color(cx),
            ))
            .child(div().flex_1().min_w_0().truncate().child(self.text))
            .children(self.actions)
            .when_some(self.dismiss, |line, dismiss| {
                let handler = dismiss.handler;
                line.child(
                    IconButton::new(dismiss.id, IconName::X, dismiss.label)
                        .on_click(move |event, window, cx| handler(event, window, cx)),
                )
            })
    }
}

pub struct StatusAction;

impl StatusAction {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
        Button::new(id)
            .label(label)
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Xs)
    }
}
