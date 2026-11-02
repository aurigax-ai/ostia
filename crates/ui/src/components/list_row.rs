use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, px,
};

use super::icon_button::IconButton;
use crate::icons::IconName;
use crate::theme::UiTheme;
use crate::tokens::{SPACE_2, SPACE_4, TextStep, UiText};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ListDensity {
    #[default]
    Settings,
    Dense,
}

impl ListDensity {
    fn line_height(self) -> f32 {
        match self {
            Self::Settings => 24.,
            Self::Dense => 20.,
        }
    }

    fn padding_y(self) -> f32 {
        match self {
            Self::Settings => 6.,
            Self::Dense => 0.,
        }
    }

    fn title_step(self) -> TextStep {
        match self {
            Self::Settings => TextStep::Base,
            Self::Dense => TextStep::Sm,
        }
    }
}

struct Expansion {
    id: ElementId,
    label: SharedString,
    content: AnyElement,
    default_open: bool,
}

#[derive(IntoElement)]
pub struct ListRow {
    lead: Option<AnyElement>,
    title: AnyElement,
    meta: Option<AnyElement>,
    detail: Option<AnyElement>,
    actions: Vec<AnyElement>,
    below: Option<AnyElement>,
    density: ListDensity,
    expansion: Option<Expansion>,
}

impl ListRow {
    pub fn new(title: impl IntoElement) -> Self {
        Self {
            lead: None,
            title: title.into_any_element(),
            meta: None,
            detail: None,
            actions: Vec::new(),
            below: None,
            density: ListDensity::Settings,
            expansion: None,
        }
    }

    pub fn lead(mut self, lead: impl IntoElement) -> Self {
        self.lead = Some(lead.into_any_element());
        self
    }

    pub fn meta(mut self, meta: impl IntoElement) -> Self {
        self.meta = Some(meta.into_any_element());
        self
    }

    pub fn detail(mut self, detail: impl IntoElement) -> Self {
        self.detail = Some(detail.into_any_element());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    pub fn below(mut self, below: impl IntoElement) -> Self {
        self.below = Some(below.into_any_element());
        self
    }

    pub fn density(mut self, density: ListDensity) -> Self {
        self.density = density;
        self
    }

    pub fn expanded(
        mut self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        default_open: bool,
        content: impl IntoElement,
    ) -> Self {
        self.expansion = Some(Expansion {
            id: id.into(),
            label: label.into(),
            content: content.into_any_element(),
            default_open,
        });
        self
    }
}

impl RenderOnce for ListRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let line = px(self.density.line_height());
        let open_state = self.expansion.as_ref().map(|expansion| {
            let default_open = expansion.default_open;
            window.use_keyed_state(expansion.id.clone(), cx, move |_, _| default_open)
        });
        let open = open_state.as_ref().is_some_and(|state| *state.read(cx));
        let toggle = self
            .expansion
            .as_ref()
            .zip(open_state)
            .map(|(expansion, state)| {
                let caret = if open {
                    IconName::CaretDown
                } else {
                    IconName::CaretRight
                };
                IconButton::new(
                    ElementId::Name(format!("{}-toggle", expansion.id).into()),
                    caret,
                    expansion.label.clone(),
                )
                .on_click(move |_, _, cx| {
                    state.update(cx, |open, cx| {
                        *open = !*open;
                        cx.notify();
                    });
                })
            });
        let has_trailing = !self.actions.is_empty() || toggle.is_some();
        let row = div()
            .flex()
            .items_start()
            .gap(SPACE_2)
            .py(px(self.density.padding_y()))
            .when_some(self.lead, |row, lead| {
                row.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .h(line)
                        .text_color(t.fg_muted)
                        .child(lead),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(SPACE_2)
                            .min_w_0()
                            .min_h(line)
                            .text_color(t.fg)
                            .ui_text(self.density.title_step(), cx)
                            .child(div().min_w_0().truncate().child(self.title))
                            .when_some(self.meta, |line, meta| {
                                line.child(
                                    div()
                                        .flex_none()
                                        .text_color(t.fg_muted)
                                        .ui_text(TextStep::Xs, cx)
                                        .child(meta),
                                )
                            }),
                    )
                    .when_some(self.detail, |text, detail| {
                        text.child(
                            div()
                                .text_color(t.fg_muted)
                                .ui_text(TextStep::Sm, cx)
                                .child(detail),
                        )
                    }),
            )
            .when(has_trailing, |row| {
                row.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(SPACE_2)
                        .min_h(line)
                        .children(self.actions)
                        .children(toggle),
                )
            });
        div()
            .flex()
            .flex_col()
            .child(row)
            .when_some(self.below, |block, below| block.child(below))
            .when_some(self.expansion.filter(|_| open), |block, expansion| {
                block.child(
                    div()
                        .mt(px(4.))
                        .mb(SPACE_2)
                        .ml(SPACE_2)
                        .pl(SPACE_4)
                        .child(expansion.content),
                )
            })
    }
}
