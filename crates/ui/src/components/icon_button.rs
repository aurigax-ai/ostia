use std::rc::Rc;

use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::ButtonRounded;
use gpui_kit::prelude::*;
use gpui_kit::{
    App, ClickEvent, ElementId, IntoElement, Pixels, RenderOnce, SharedString, Window, px,
};

use super::button::{ClickHandler, ROW_RADIUS, VariantColors, kit_button};
use crate::icons::{IconName, IconSize, icon};
use crate::theme::UiTheme;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IconButtonSize {
    Bar,
    #[default]
    Row,
}

impl IconButtonSize {
    pub(crate) fn pixels(self) -> Pixels {
        match self {
            Self::Bar => px(28.),
            Self::Row => px(22.),
        }
    }
}

#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    icon: IconName,
    label: SharedString,
    size: IconButtonSize,
    pressed: bool,
    disabled: bool,
    on_click: Option<ClickHandler>,
}

impl IconButton {
    pub fn new(id: impl Into<ElementId>, icon: IconName, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            icon,
            label: label.into(),
            size: IconButtonSize::Row,
            pressed: false,
            disabled: false,
            on_click: None,
        }
    }

    pub fn size(mut self, size: IconButtonSize) -> Self {
        self.size = size;
        self
    }

    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = pressed;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
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

const HOVER_GROUP: &str = "icon-button";

impl RenderOnce for IconButton {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let rest = if self.pressed { t.fg } else { t.fg_muted };
        let colors = VariantColors {
            background: if self.pressed {
                t.surface_3
            } else {
                gpui_kit::transparent_black()
            },
            hover: t.surface_3,
            foreground: rest,
            border: None,
        };
        let side = self.size.pixels();
        let mut button = kit_button(self.id, &colors, cx)
            .group(HOVER_GROUP)
            .size(side)
            .p_0()
            .border_0()
            .rounded(ButtonRounded::Size(ROW_RADIUS))
            .accessibility_label(self.label.clone())
            .tooltip(self.label)
            .disabled(self.disabled)
            .child(
                icon(self.icon, IconSize::Standard, rest)
                    .group_hover(HOVER_GROUP, move |style| style.text_color(t.fg)),
            );
        if let Some(handler) = self.on_click {
            button = button.on_click(move |event, window, cx| handler(event, window, cx));
        }
        button
    }
}
