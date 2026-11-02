use std::rc::Rc;

use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu};
use gpui_kit::prelude::*;
use gpui_kit::{
    Anchor, App, ClickEvent, Context, ElementId, IntoElement, RenderOnce, SharedString, Window,
    div, px,
};

use super::button::{
    ButtonSize, ButtonVariant, ClickHandler, bordered_if, kit_button, segment_corners,
    variant_colors,
};
use crate::icons::{IconName, IconSize, icon};
use crate::tokens::UiText;

type MenuBuilder = Rc<dyn Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu>;

#[derive(IntoElement)]
pub struct SplitButton {
    id: SharedString,
    label: SharedString,
    menu_label: SharedString,
    variant: ButtonVariant,
    size: ButtonSize,
    on_click: ClickHandler,
    menu: MenuBuilder,
}

impl SplitButton {
    pub fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        menu_label: impl Into<SharedString>,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        menu: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            menu_label: menu_label.into(),
            variant: ButtonVariant::Default,
            size: ButtonSize::Sm,
            on_click: Rc::new(on_click),
            menu: Rc::new(menu),
        }
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: ButtonSize) -> Self {
        self.size = size;
        self
    }
}

impl RenderOnce for SplitButton {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let colors = variant_colors(self.variant, false, cx);
        let height = self.size.height();
        let radius = self.size.radius();
        let on_click = self.on_click;
        let menu = self.menu;
        let main_id = ElementId::Name(format!("{}-main", self.id).into());
        let caret_id = ElementId::Name(format!("{}-menu", self.id).into());
        let main = segment_corners(
            bordered_if(kit_button(main_id, &colors, cx), colors.border),
            true,
            false,
            radius,
        )
        .h(height)
        .px(self.size.padding())
        .on_click(move |event, window, cx| on_click(event, window, cx))
        .child(
            div()
                .ui_text(self.size.text(), cx)
                .ui_weight_medium(cx)
                .text_color(colors.foreground)
                .child(self.label),
        );
        let caret = segment_corners(
            bordered_if(kit_button(caret_id, &colors, cx), colors.border),
            false,
            true,
            radius,
        )
        .h(height)
        .w(height)
        .p_0()
        .accessibility_label(self.menu_label)
        .child(icon(
            IconName::CaretDown,
            IconSize::Standard,
            colors.foreground,
        ))
        .dropdown_menu_with_anchor(Anchor::TopRight, move |popup, window, cx| {
            menu(popup, window, cx)
        });
        div()
            .flex()
            .items_center()
            .child(main)
            .child(
                div()
                    .w(px(1.))
                    .h(height)
                    .bg(colors.foreground.opacity(0.25)),
            )
            .child(caret)
    }
}
