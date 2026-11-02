use std::rc::Rc;

use gpui_kit::component::button::{Button as KitButton, ButtonVariants as _};
use gpui_kit::prelude::*;
use gpui_kit::{App, ClickEvent, ElementId, IntoElement, RenderOnce, SharedString, Window, div};

use super::button::ClickHandler;
use crate::tokens::{TextStep, UiText};

#[derive(IntoElement)]
pub struct TextLink {
    id: ElementId,
    label: SharedString,
    on_click: Option<ClickHandler>,
}

impl TextLink {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            on_click: None,
        }
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for TextLink {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let mut link = KitButton::new(self.id).link().child(
            div()
                .ui_text(TextStep::Base, cx)
                .ui_weight_medium(cx)
                .child(self.label),
        );
        if let Some(handler) = self.on_click {
            link = link.on_click(move |event, window, cx| handler(event, window, cx));
        }
        link
    }
}
