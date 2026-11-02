use std::rc::Rc;

use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{
    Button as KitButton, ButtonCustomVariant, ButtonRounded, ButtonVariants as _,
};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, ClickEvent, ElementId, Hsla, IntoElement, Pixels, RenderOnce, SharedString,
    Window, div, px, transparent_black,
};

use crate::icons::{IconName, IconSize, icon};
use crate::theme::{Appearance, UiTheme};
use crate::tokens::{RADIUS_LG, RADIUS_MD, RADIUS_SM, TextStep, UiText};

pub type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonVariant {
    #[default]
    Default,
    Outline,
    Secondary,
    Ghost,
    Destructive,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonSize {
    Xs,
    Sm,
    #[default]
    Default,
}

impl ButtonSize {
    pub(crate) fn height(self) -> Pixels {
        match self {
            Self::Xs => px(24.),
            Self::Sm => px(28.),
            Self::Default => px(32.),
        }
    }

    pub(crate) fn padding(self) -> Pixels {
        match self {
            Self::Xs => px(8.),
            Self::Sm | Self::Default => px(10.),
        }
    }

    pub(crate) fn gap(self) -> Pixels {
        match self {
            Self::Xs | Self::Sm => px(4.),
            Self::Default => px(6.),
        }
    }

    pub(crate) fn radius(self) -> Pixels {
        match self {
            Self::Xs | Self::Sm => RADIUS_MD,
            Self::Default => RADIUS_LG,
        }
    }

    pub(crate) fn text(self) -> TextStep {
        match self {
            Self::Xs | Self::Sm => TextStep::Sm,
            Self::Default => TextStep::Base,
        }
    }
}

pub(crate) struct VariantColors {
    pub(crate) background: Hsla,
    pub(crate) hover: Hsla,
    pub(crate) foreground: Hsla,
    pub(crate) border: Option<Hsla>,
}

pub(crate) fn variant_colors(variant: ButtonVariant, pressed: bool, cx: &App) -> VariantColors {
    let t = cx.tokens();
    let dark = cx.ui_theme().source.appearance == Appearance::Dark;
    match variant {
        ButtonVariant::Default => VariantColors {
            background: t.brand,
            hover: t.brand.opacity(0.8),
            foreground: t.on_brand,
            border: None,
        },
        ButtonVariant::Outline => VariantColors {
            background: match (pressed, dark) {
                (true, _) => t.surface_3,
                (false, true) => t.line_strong.opacity(0.3),
                (false, false) => t.bg,
            },
            hover: match (pressed, dark) {
                (true, _) => t.surface_3,
                (false, true) => t.line_strong.opacity(0.5),
                (false, false) => t.surface_2,
            },
            foreground: t.fg,
            border: Some(if dark { t.line_strong } else { t.line }),
        },
        ButtonVariant::Secondary => VariantColors {
            background: t.surface_2,
            hover: t.surface_3,
            foreground: t.fg,
            border: None,
        },
        ButtonVariant::Ghost => VariantColors {
            background: if pressed {
                t.surface_3
            } else {
                transparent_black()
            },
            hover: if pressed {
                t.surface_3
            } else if dark {
                t.surface_2.opacity(0.5)
            } else {
                t.surface_2
            },
            foreground: t.fg,
            border: None,
        },
        ButtonVariant::Destructive => {
            let (rest, hover) = if dark { (0.2, 0.3) } else { (0.1, 0.2) };
            VariantColors {
                background: t.attn_fg.opacity(rest),
                hover: t.attn_fg.opacity(hover),
                foreground: t.attn_fg,
                border: None,
            }
        }
    }
}

pub(crate) fn kit_button(id: ElementId, colors: &VariantColors, cx: &App) -> KitButton {
    KitButton::new(id).custom(
        ButtonCustomVariant::new(cx)
            .color(colors.background)
            .hover(colors.hover)
            .active(colors.hover)
            .foreground(colors.foreground)
            .shadow(false),
    )
}

pub(crate) fn bordered_if(button: KitButton, border: Option<Hsla>) -> KitButton {
    match border {
        Some(color) => button.border_1().border_color(color),
        None => button.border_0(),
    }
}

pub(crate) fn segment_corners(
    button: KitButton,
    first: bool,
    last: bool,
    radius: Pixels,
) -> KitButton {
    let mut button = button.rounded(ButtonRounded::None);
    if first {
        button = button.rounded_tl(radius).rounded_bl(radius);
    } else {
        button = button.border_l_0();
    }
    if last {
        button = button.rounded_tr(radius).rounded_br(radius);
    }
    button
}

#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    label: Option<SharedString>,
    icon: Option<IconName>,
    trailing: Option<AnyElement>,
    variant: ButtonVariant,
    size: ButtonSize,
    disabled: bool,
    tooltip: Option<SharedString>,
    on_click: Option<ClickHandler>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            label: None,
            icon: None,
            trailing: None,
            variant: ButtonVariant::Default,
            size: ButtonSize::Default,
            disabled: false,
            tooltip: None,
            on_click: None,
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing = Some(element.into_any_element());
        self
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: ButtonSize) -> Self {
        self.size = size;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
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

impl RenderOnce for Button {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let colors = variant_colors(self.variant, false, cx);
        let mut button = bordered_if(kit_button(self.id, &colors, cx), colors.border)
            .h(self.size.height())
            .px(self.size.padding())
            .rounded(ButtonRounded::Size(self.size.radius()))
            .disabled(self.disabled)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(self.size.gap())
                    .ui_text(self.size.text(), cx)
                    .ui_weight_medium(cx)
                    .text_color(colors.foreground)
                    .when_some(self.icon, |row, name| {
                        row.child(icon(name, IconSize::Standard, colors.foreground))
                    })
                    .when_some(self.label, |row, label| row.child(label))
                    .when_some(self.trailing, |row, element| row.child(element)),
            );
        if let Some(tooltip) = self.tooltip {
            button = button.tooltip(tooltip);
        }
        if let Some(handler) = self.on_click {
            button = button.on_click(move |event, window, cx| handler(event, window, cx));
        }
        button
    }
}

pub(crate) const ROW_RADIUS: Pixels = RADIUS_SM;
