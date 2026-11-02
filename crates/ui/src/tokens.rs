use std::time::Duration;

use gpui_kit::{App, FontWeight, Pixels, Styled, px};

use crate::theme::UiTheme;

pub const SPACE_1: Pixels = px(4.);
pub const SPACE_2: Pixels = px(8.);
pub const SPACE_3: Pixels = px(12.);
pub const SPACE_4: Pixels = px(16.);
pub const SPACE_5: Pixels = px(20.);
pub const SPACE_6: Pixels = px(24.);
pub const SPACE_8: Pixels = px(32.);

pub const RADIUS_SM: Pixels = px(6.);
pub const RADIUS_MD: Pixels = px(8.);
pub const RADIUS_LG: Pixels = px(10.);

pub const RAIL_W: Pixels = px(240.);
pub const RAIL_W_MIN: Pixels = px(180.);
pub const RAIL_W_MAX: Pixels = px(480.);
pub const RAIL_W_COLLAPSED: Pixels = px(44.);
pub const FILES_W: Pixels = px(260.);
pub const RIGHT_W: Pixels = px(340.);
pub const TOPBAR_H: Pixels = px(36.);
pub const TABSTRIP_H: Pixels = px(34.);
pub const TAB_MAX_W: Pixels = px(200.);
pub const TAB_MIN_W: Pixels = px(96.);
pub const CONTROL_H: Pixels = px(28.);
pub const STATUS_LINE_H: Pixels = px(32.);
pub const PROMPT_CARD_MAX_W: Pixels = px(560.);
pub const SETTINGS_NAV_W: Pixels = px(210.);
pub const SETTINGS_CONTENT_MAX_W: Pixels = px(768.);
pub const PALETTE_W: Pixels = px(752.);
pub const SCROLLBAR_SIZE: Pixels = px(11.);

pub const MOTION_FAST: Duration = Duration::from_millis(90);
pub const MOTION_BASE: Duration = Duration::from_millis(150);
pub const MOTION_PANEL: Duration = Duration::from_millis(180);
pub const MOTION_HIGHLIGHT: Duration = Duration::from_millis(2000);
pub const MOTION_FAST_EXIT: Duration = Duration::from_millis(63);
pub const MOTION_BASE_EXIT: Duration = Duration::from_millis(105);
pub const MOTION_PULSE: Duration = Duration::from_millis(1500);
pub const MOTION_BREATHE: Duration = Duration::from_millis(2400);
pub const BREATHE_MIN_OPACITY: f32 = 0.55;
pub const UNFOCUSED_PANE_DIM: f32 = 0.3;

pub const EASE_OUT: (f32, f32, f32, f32) = (0.2, 0., 0., 1.);
pub const EASE_IN: (f32, f32, f32, f32) = (0.4, 0., 1., 1.);
pub const EASE_IN_OUT: (f32, f32, f32, f32) = (0.4, 0., 0.2, 1.);

pub const FONT_UI: &str = "Inter";
pub const FONT_CODE: &str = "Geist Mono";
pub const FONT_TERMINAL: &str = "Hack Nerd Font Mono";
pub const UI_SIZE_DEFAULT: f32 = 13.;
pub const UI_WEIGHT_DEFAULT: f32 = 400.;
pub const TERMINAL_FONT_SIZE: f32 = 13.;
pub const TERMINAL_LINE_HEIGHT: f32 = 1.15;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextStep {
    Xs,
    Sm,
    Base,
    Emphasis,
    Lg,
}

impl TextStep {
    pub fn metrics(self, ui_size: f32) -> (f32, f32) {
        match self {
            Self::Xs => {
                let size = (ui_size - 2.).max(11.);
                (size, size + 5.)
            }
            Self::Sm => {
                let size = (ui_size - 1.).max(11.);
                (size, size + 6.)
            }
            Self::Base => (ui_size, ui_size + 7.),
            Self::Emphasis => (ui_size + 1., ui_size + 7.),
            Self::Lg => (ui_size + 3., ui_size + 9.),
        }
    }
}

pub trait UiText: Styled + Sized {
    fn ui_text(self, step: TextStep, cx: &App) -> Self {
        let (size, line) = step.metrics(cx.ui_theme().ui_size);
        self.text_size(px(size)).line_height(px(line))
    }

    fn ui_weight_normal(self, cx: &App) -> Self {
        self.font_weight(FontWeight(cx.ui_theme().ui_weight))
    }

    fn ui_weight_medium(self, cx: &App) -> Self {
        self.font_weight(FontWeight(cx.ui_theme().ui_weight + 100.))
    }

    fn ui_weight_semibold(self, cx: &App) -> Self {
        self.font_weight(FontWeight(cx.ui_theme().ui_weight + 200.))
    }

    fn font_code(self) -> Self {
        self.font_family(FONT_CODE)
    }
}

impl<T: Styled + Sized> UiText for T {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_at_the_default_size_matches_the_design_system() {
        let at_13: Vec<_> = [
            TextStep::Xs,
            TextStep::Sm,
            TextStep::Base,
            TextStep::Emphasis,
            TextStep::Lg,
        ]
        .map(|step| step.metrics(13.))
        .to_vec();
        assert_eq!(
            at_13,
            vec![(11., 16.), (12., 18.), (13., 20.), (14., 20.), (16., 22.)]
        );
    }

    #[test]
    fn nothing_is_smaller_than_eleven_pixels() {
        assert_eq!(TextStep::Xs.metrics(11.).0, 11.);
        assert_eq!(TextStep::Sm.metrics(11.).0, 11.);
    }
}
