use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, ElementId, IntoElement, RenderOnce, Role, SharedString, TestSupportExt as _,
    Window, div, px,
};

use crate::theme::UiTheme;
use crate::tokens::{SPACE_2, TextStep, UiText};

const EMPTY_PADDING_Y: f32 = 6.;

#[derive(IntoElement)]
pub struct SettingsList {
    id: SharedString,
    label: SharedString,
    empty: SharedString,
    add: Option<AnyElement>,
    rows: Vec<AnyElement>,
}

impl SettingsList {
    pub fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        empty: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            empty: empty.into(),
            add: None,
            rows: Vec::new(),
        }
    }

    pub fn add_row(mut self, add: impl IntoElement) -> Self {
        self.add = Some(add.into_any_element());
        self
    }
}

impl ParentElement for SettingsList {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.rows.extend(elements);
    }
}

impl RenderOnce for SettingsList {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let id = self.id;
        let body = if self.rows.is_empty() {
            div()
                .id(ElementId::Name(format!("{id}-empty").into()))
                .aria_label(self.empty.clone())
                .test_support()
                .py(px(EMPTY_PADDING_Y))
                .text_color(t.fg_muted)
                .ui_text(TextStep::Sm, cx)
                .child(self.empty)
                .into_any_element()
        } else {
            let items = self.rows.into_iter().enumerate().map(|(index, row)| {
                div()
                    .id(ElementId::NamedInteger(
                        format!("{id}-item").into(),
                        index as u64,
                    ))
                    .role(Role::ListItem)
                    .test_support()
                    .child(row)
            });
            div()
                .id(id.clone())
                .role(Role::List)
                .aria_label(self.label)
                .test_support()
                .flex()
                .flex_col()
                .children(items)
                .into_any_element()
        };
        div().child(body).when_some(self.add, |list, add| {
            list.child(div().pt(SPACE_2).child(add))
        })
    }
}
