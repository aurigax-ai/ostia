use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, px};

use super::badge::{Badge, BadgeVariant};
use super::switch::Switch;
use crate::theme::UiTheme;
use crate::tokens::{SPACE_2, SPACE_6, TextStep, UiText};

const LABEL_BASIS: f32 = 384.;
const ROW_PADDING_Y: f32 = 6.;
const TEXT_GAP: f32 = 2.;

#[derive(IntoElement)]
pub struct ControlRow {
    label: SharedString,
    desc: Option<SharedString>,
    error: Option<SharedString>,
    label_hint: Option<AnyElement>,
    below: Option<AnyElement>,
    control: Vec<AnyElement>,
}

impl ControlRow {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            desc: None,
            error: None,
            label_hint: None,
            below: None,
            control: Vec::new(),
        }
    }

    pub fn desc(mut self, desc: impl Into<SharedString>) -> Self {
        self.desc = Some(desc.into());
        self
    }

    pub fn error(mut self, error: Option<SharedString>) -> Self {
        self.error = error;
        self
    }

    pub fn label_hint(mut self, hint: impl IntoElement) -> Self {
        self.label_hint = Some(hint.into_any_element());
        self
    }

    pub fn below(mut self, below: impl IntoElement) -> Self {
        self.below = Some(below.into_any_element());
        self
    }

    pub fn control(mut self, control: impl IntoElement) -> Self {
        self.control.push(control.into_any_element());
        self
    }
}

impl RenderOnce for ControlRow {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let top_aligned = self.desc.is_some() || self.error.is_some() || self.below.is_some();
        let label_line = div()
            .flex()
            .items_baseline()
            .gap(SPACE_2)
            .min_w_0()
            .text_color(t.fg)
            .ui_text(TextStep::Base, cx)
            .child(self.label)
            .when_some(self.label_hint, |line, hint| line.child(hint));
        div()
            .flex()
            .flex_wrap()
            .justify_between()
            .gap_x(SPACE_6)
            .gap_y(SPACE_2)
            .py(px(ROW_PADDING_Y))
            .map(|row| {
                if top_aligned {
                    row.items_start()
                } else {
                    row.items_center()
                }
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(TEXT_GAP))
                    .min_w_0()
                    .flex_grow(1.)
                    .flex_basis(px(LABEL_BASIS))
                    .child(label_line)
                    .when_some(self.desc, |text, desc| {
                        text.child(
                            div()
                                .text_color(t.fg_muted)
                                .ui_text(TextStep::Sm, cx)
                                .child(desc),
                        )
                    })
                    .when_some(self.error, |text, error| {
                        text.child(
                            div()
                                .text_color(t.attn_fg)
                                .ui_text(TextStep::Sm, cx)
                                .child(error),
                        )
                    })
                    .when_some(self.below, |text, below| {
                        text.child(div().mt(px(ROW_PADDING_Y)).child(below))
                    }),
            )
            .when(!self.control.is_empty(), |row| {
                row.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(SPACE_2)
                        .min_w_0()
                        .max_w_full()
                        .children(self.control),
                )
            })
    }
}

pub struct ToggleRow;

impl ToggleRow {
    pub fn new(
        id: impl Into<gpui_kit::ElementId>,
        label: impl Into<SharedString>,
        desc: impl Into<SharedString>,
        checked: bool,
        on_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
    ) -> ControlRow {
        let label = label.into();
        ControlRow::new(label.clone())
            .desc(desc)
            .control(Switch::new(id, label, checked).on_change(on_change))
    }
}

#[derive(IntoElement)]
pub struct ExperimentalBadge {
    label: SharedString,
}

impl ExperimentalBadge {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
        }
    }
}

impl RenderOnce for ExperimentalBadge {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        Badge::new(self.label).variant(BadgeVariant::Outline)
    }
}
