use std::rc::Rc;

use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, KeyDownEvent, RenderOnce, Role,
    SharedString, TestSupportExt as _, Window, div,
};

use super::button::{ClickHandler, ROW_RADIUS};
use crate::focus::FocusRing as _;
use crate::theme::UiTheme;

#[derive(IntoElement)]
pub struct RowButton {
    id: ElementId,
    label: SharedString,
    active: bool,
    on_click: Option<ClickHandler>,
    children: Vec<AnyElement>,
}

impl RowButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            active: false,
            on_click: None,
            children: Vec::new(),
        }
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for RowButton {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for RowButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let focus = window
            .use_keyed_state(self.id.clone(), cx, |_, cx| {
                cx.focus_handle().tab_stop(true)
            })
            .read(cx)
            .clone();
        let click = self.on_click;
        let key_click = click.clone();
        div()
            .id(self.id)
            .role(Role::Button)
            .aria_label(self.label)
            .test_support()
            .track_focus(&focus)
            .relative()
            .flex()
            .w_full()
            .min_w_0()
            .items_center()
            .rounded(ROW_RADIUS)
            .text_color(if self.active { t.fg } else { t.fg_muted })
            .when(self.active, |row| row.bg(t.surface_2))
            .hover(move |style| style.bg(t.surface_2).text_color(t.fg))
            .focus_ring(&focus, window, cx)
            .when_some(click, |row, handler| {
                row.on_click(move |event, window, cx| handler(event, window, cx))
            })
            .when_some(key_click, |row, handler| {
                row.on_key_down(move |event: &KeyDownEvent, window, cx| {
                    let key = event.keystroke.key.as_str();
                    if key == "enter" || key == "space" {
                        handler(&ClickEvent::default(), window, cx);
                        cx.stop_propagation();
                    }
                })
            })
            .children(self.children)
    }
}
