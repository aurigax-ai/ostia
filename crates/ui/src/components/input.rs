use gpui_kit::component::input::{Input as KitInput, InputState};
use gpui_kit::prelude::*;
use gpui_kit::{App, Entity, IntoElement, Pixels, RenderOnce, SharedString, Window, px};

use crate::tokens::{CONTROL_H, RADIUS_MD, TextStep, UiText};

#[derive(IntoElement)]
pub struct Input {
    state: Entity<InputState>,
    label: SharedString,
    width: Option<Pixels>,
    code: bool,
    disabled: bool,
}

impl Input {
    pub fn new(state: &Entity<InputState>, label: impl Into<SharedString>) -> Self {
        Self {
            state: state.clone(),
            label: label.into(),
            width: None,
            code: false,
            disabled: false,
        }
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = Some(px(width));
        self
    }

    pub fn code(mut self) -> Self {
        self.code = true;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

impl RenderOnce for Input {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let input = KitInput::new(&self.state)
            .aria_label(self.label)
            .disabled(self.disabled)
            .h(CONTROL_H)
            .rounded(RADIUS_MD)
            .ui_text(TextStep::Base, cx)
            .when_some(self.width, |input, width| input.w(width));
        if self.code { input.font_code() } else { input }
    }
}
