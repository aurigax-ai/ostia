use gpui_kit::component::IndexPath;
use gpui_kit::component::searchable_list::SearchableListItem;
pub use gpui_kit::component::select::SelectEvent;
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::prelude::*;
use gpui_kit::{App, Context, Entity, IntoElement, Pixels, RenderOnce, SharedString, Window, px};

use crate::tokens::{CONTROL_H, RADIUS_MD, TextStep, UiText};

const DEFAULT_WIDTH: f32 = 176.;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectOption {
    pub value: SharedString,
    pub label: SharedString,
}

impl SelectOption {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
        }
    }
}

impl SearchableListItem for SelectOption {
    type Value = SharedString;

    fn title(&self) -> SharedString {
        self.label.clone()
    }

    fn value(&self) -> &Self::Value {
        &self.value
    }
}

pub type SelectFieldState = SelectState<Vec<SelectOption>>;

pub fn select_state<V: 'static>(
    options: Vec<SelectOption>,
    selected: &str,
    window: &mut Window,
    cx: &mut Context<V>,
) -> Entity<SelectFieldState> {
    let index = options
        .iter()
        .position(|option| option.value == selected)
        .map(IndexPath::new);
    cx.new(|cx| SelectState::new(options, index, window, cx))
}

#[derive(IntoElement)]
pub struct SelectField {
    state: Entity<SelectFieldState>,
    label: SharedString,
    width: Pixels,
    disabled: bool,
}

impl SelectField {
    pub fn new(state: &Entity<SelectFieldState>, label: impl Into<SharedString>) -> Self {
        Self {
            state: state.clone(),
            label: label.into(),
            width: px(DEFAULT_WIDTH),
            disabled: false,
        }
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = px(width);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

impl RenderOnce for SelectField {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        Select::new(&self.state)
            .accessibility_label(self.label)
            .disabled(self.disabled)
            .w(self.width)
            .h(CONTROL_H)
            .rounded(RADIUS_MD)
            .ui_text(TextStep::Sm, cx)
    }
}
