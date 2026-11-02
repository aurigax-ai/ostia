use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, px};

use crate::theme::UiTheme;
use crate::tokens::{SPACE_2, SPACE_3, SPACE_6, TextStep, UiText};

const GROUP_TOP: f32 = 28.;
const HEAD_GAP: f32 = 6.;
const TEXT_GAP: f32 = 2.;

#[derive(IntoElement)]
pub struct SettingsPage {
    title: SharedString,
    desc: Option<SharedString>,
    actions: Vec<AnyElement>,
    children: Vec<AnyElement>,
}

impl SettingsPage {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            desc: None,
            actions: Vec::new(),
            children: Vec::new(),
        }
    }

    pub fn desc(mut self, desc: impl Into<SharedString>) -> Self {
        self.desc = Some(desc.into());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

impl ParentElement for SettingsPage {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for SettingsPage {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let head = div()
            .min_w_0()
            .child(
                div()
                    .mb(px(HEAD_GAP))
                    .text_color(t.fg)
                    .ui_text(TextStep::Lg, cx)
                    .ui_weight_semibold(cx)
                    .child(self.title),
            )
            .when_some(self.desc, |head, desc| {
                head.child(
                    div()
                        .mb(SPACE_3)
                        .text_color(t.fg_muted)
                        .ui_text(TextStep::Sm, cx)
                        .child(desc),
                )
            });
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(SPACE_6)
                    .child(head)
                    .when(!self.actions.is_empty(), |row| {
                        row.child(
                            div()
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(SPACE_2)
                                .children(self.actions),
                        )
                    }),
            )
            .children(self.children)
    }
}

#[derive(IntoElement)]
pub struct SettingsGroup {
    title: SharedString,
    desc: Option<SharedString>,
    action: Option<AnyElement>,
    first: bool,
    children: Vec<AnyElement>,
}

impl SettingsGroup {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            desc: None,
            action: None,
            first: false,
            children: Vec::new(),
        }
    }

    pub fn desc(mut self, desc: impl Into<SharedString>) -> Self {
        self.desc = Some(desc.into());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    pub fn first(mut self) -> Self {
        self.first = true;
        self
    }
}

impl ParentElement for SettingsGroup {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for SettingsGroup {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        div()
            .flex()
            .flex_col()
            .mt(if self.first { SPACE_3 } else { px(GROUP_TOP) })
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(SPACE_6)
                    .mb(SPACE_2)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(TEXT_GAP))
                            .min_w_0()
                            .child(
                                div()
                                    .text_color(t.fg)
                                    .ui_text(TextStep::Emphasis, cx)
                                    .ui_weight_semibold(cx)
                                    .child(self.title),
                            )
                            .when_some(self.desc, |text, desc| {
                                text.child(
                                    div()
                                        .text_color(t.fg_muted)
                                        .ui_text(TextStep::Sm, cx)
                                        .child(desc),
                                )
                            }),
                    )
                    .when_some(self.action, |row, action| {
                        row.child(
                            div()
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(SPACE_2)
                                .child(action),
                        )
                    }),
            )
            .children(self.children)
    }
}

#[derive(IntoElement)]
pub struct SettingsSubgroup {
    title: SharedString,
    desc: Option<SharedString>,
}

impl SettingsSubgroup {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            desc: None,
        }
    }

    pub fn desc(mut self, desc: impl Into<SharedString>) -> Self {
        self.desc = Some(desc.into());
        self
    }
}

impl RenderOnce for SettingsSubgroup {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        div()
            .mb(SPACE_2)
            .child(
                div()
                    .text_color(t.fg)
                    .ui_text(TextStep::Base, cx)
                    .ui_weight_medium(cx)
                    .child(self.title),
            )
            .when_some(self.desc, |block, desc| {
                block.child(
                    div()
                        .mt(px(TEXT_GAP))
                        .text_color(t.fg_muted)
                        .ui_text(TextStep::Sm, cx)
                        .child(desc),
                )
            })
    }
}
