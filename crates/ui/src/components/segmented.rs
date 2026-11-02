use std::rc::Rc;

use gpui_kit::prelude::*;
use gpui_kit::{App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, px};

use super::button::{ButtonVariant, bordered_if, kit_button, segment_corners, variant_colors};
use crate::icons::{IconName, IconSize, icon};
use crate::theme::UiTheme;
use crate::tokens::{CONTROL_H, RADIUS_MD, TextStep, UiText};

pub struct SegmentedOption<T> {
    pub value: T,
    pub label: SharedString,
    pub icon: Option<IconName>,
}

impl<T> SegmentedOption<T> {
    pub fn new(value: T, label: impl Into<SharedString>) -> Self {
        Self {
            value,
            label: label.into(),
            icon: None,
        }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }
}

type ChangeHandler<T> = Rc<dyn Fn(&T, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Segmented<T: Clone + PartialEq + 'static> {
    id: SharedString,
    value: T,
    options: Vec<SegmentedOption<T>>,
    icon_only: bool,
    on_change: ChangeHandler<T>,
}

impl<T: Clone + PartialEq + 'static> Segmented<T> {
    pub fn new(
        id: impl Into<SharedString>,
        value: T,
        options: Vec<SegmentedOption<T>>,
        on_change: impl Fn(&T, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            value,
            options,
            icon_only: false,
            on_change: Rc::new(on_change),
        }
    }

    pub fn icon_only(mut self) -> Self {
        self.icon_only = true;
        self
    }
}

impl<T: Clone + PartialEq + 'static> RenderOnce for Segmented<T> {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let count = self.options.len();
        let id = self.id.clone();
        let icon_only = self.icon_only;
        let value = self.value;
        let on_change = self.on_change;
        let buttons = self.options.into_iter().enumerate().map(|(index, option)| {
            let pressed = option.value == value;
            let colors = variant_colors(ButtonVariant::Outline, pressed, cx);
            let foreground = if pressed { t.fg } else { t.fg_muted };
            let element_id = ElementId::NamedInteger(id.clone(), index as u64);
            let on_change = on_change.clone();
            let picked = option.value.clone();
            let mut button = segment_corners(
                bordered_if(kit_button(element_id, &colors, cx), colors.border),
                index == 0,
                index + 1 == count,
                RADIUS_MD,
            )
            .h(CONTROL_H)
            .on_click(move |_, window, cx| on_change(&picked, window, cx));
            if icon_only {
                button = button
                    .w(CONTROL_H)
                    .p_0()
                    .accessibility_label(option.label.clone())
                    .tooltip(option.label.clone());
            } else {
                button = button.px(px(10.));
            }
            button.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .ui_text(TextStep::Sm, cx)
                    .ui_weight_medium(cx)
                    .text_color(foreground)
                    .when_some(option.icon, |row, name| {
                        row.child(icon(name, IconSize::Standard, foreground))
                    })
                    .when(!icon_only, |row| row.child(option.label)),
            )
        });
        div().flex().items_center().children(buttons)
    }
}
