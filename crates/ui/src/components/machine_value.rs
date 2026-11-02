use gpui_kit::prelude::*;
use gpui_kit::{
    App, ElementId, IntoElement, RenderOnce, Role, SharedString, TestSupportExt as _, Window, div,
};

use super::tooltip::hint;
use crate::theme::UiTheme;
use crate::tokens::{TextStep, UiText};

#[derive(IntoElement)]
pub struct MachineValue {
    id: ElementId,
    value: SharedString,
    label: Option<SharedString>,
}

impl MachineValue {
    pub fn new(id: impl Into<ElementId>, value: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            value: value.into(),
            label: None,
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }
}

impl RenderOnce for MachineValue {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let label = self.label.unwrap_or_else(|| self.value.clone());
        div()
            .id(self.id)
            .role(Role::Label)
            .aria_label(label)
            .test_support()
            .min_w_0()
            .truncate()
            .font_code()
            .text_color(t.fg_muted)
            .ui_text(TextStep::Xs, cx)
            .tooltip(hint(self.value.clone()))
            .child(self.value)
    }
}
