use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, px};

use crate::theme::UiTheme;
use crate::tokens::{SPACE_2, SPACE_3, SPACE_4, SPACE_6, TextStep, UiText};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EmptySurfaceSize {
    #[default]
    Lg,
    Sm,
}

#[derive(IntoElement)]
pub struct EmptyState {
    size: EmptySurfaceSize,
    icon: Option<AnyElement>,
    title: Option<SharedString>,
    desc: Vec<SharedString>,
    actions: Vec<AnyElement>,
}

impl EmptyState {
    pub fn surface() -> Self {
        Self {
            size: EmptySurfaceSize::Lg,
            icon: None,
            title: None,
            desc: Vec::new(),
            actions: Vec::new(),
        }
    }

    pub fn size(mut self, size: EmptySurfaceSize) -> Self {
        self.size = size;
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn desc(mut self, line: impl Into<SharedString>) -> Self {
        self.desc.push(line.into());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

impl RenderOnce for EmptyState {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let (title_step, desc_step) = match self.size {
            EmptySurfaceSize::Lg => (TextStep::Lg, TextStep::Base),
            EmptySurfaceSize::Sm => (TextStep::Base, TextStep::Sm),
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .size_full()
            .min_w_0()
            .items_center()
            .justify_center()
            .gap(SPACE_4)
            .p(SPACE_6)
            .text_center()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(SPACE_2)
                    .when_some(self.icon, |header, icon| {
                        header.child(
                            div()
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(32.))
                                .rounded(px(8.))
                                .bg(t.surface_2)
                                .text_color(t.fg)
                                .child(icon),
                        )
                    })
                    .when_some(self.title, |header, title| {
                        header.child(
                            div()
                                .text_color(t.fg)
                                .ui_text(title_step, cx)
                                .ui_weight_semibold(cx)
                                .child(title),
                        )
                    })
                    .children(self.desc.into_iter().map(|line| {
                        div()
                            .text_color(t.fg_muted)
                            .ui_text(desc_step, cx)
                            .child(line)
                    })),
            )
            .when(!self.actions.is_empty(), |block| {
                block.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(SPACE_2)
                        .children(self.actions),
                )
            })
    }
}

#[derive(IntoElement)]
pub struct EmptyBlock {
    title: SharedString,
    desc: Option<SharedString>,
    action: Option<AnyElement>,
}

impl EmptyBlock {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            desc: None,
            action: None,
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
}

fn with_full_stop(title: &str) -> String {
    let ends = title
        .chars()
        .last()
        .is_some_and(|last| matches!(last, '.' | '!' | '?' | '。' | '！' | '？'));
    if ends {
        title.to_owned()
    } else {
        format!("{title}.")
    }
}

impl RenderOnce for EmptyBlock {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let lead = with_full_stop(&self.title);
        let text = match self.desc {
            Some(desc) => format!("{lead} {desc}"),
            None => lead,
        };
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(SPACE_3)
            .gap_y(px(6.))
            .py(px(6.))
            .text_color(t.fg_muted)
            .ui_text(TextStep::Sm, cx)
            .child(text)
            .children(self.action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_title_gets_one_full_stop() {
        assert_eq!(with_full_stop("No items"), "No items.");
        assert_eq!(with_full_stop("No items."), "No items.");
        assert_eq!(with_full_stop("沒有項目。"), "沒有項目。");
    }
}
