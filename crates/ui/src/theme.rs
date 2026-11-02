use gpui_kit::{App, Global, Hsla};

use crate::color::{Rgba8, readable_on};
use crate::theme_bridge::apply_to_kit;
use crate::theme_data::{COLOR_SCHEMES, THEMES};
use crate::tokens::{UI_SIZE_DEFAULT, UI_WEIGHT_DEFAULT};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    Dark,
    Light,
}

#[derive(Debug)]
pub struct ThemeSource {
    pub id: &'static str,
    pub name: &'static str,
    pub appearance: Appearance,
    pub color_scheme: &'static str,
    pub bg: Rgba8,
    pub bg_sunken: Rgba8,
    pub surface_1: Rgba8,
    pub surface_2: Rgba8,
    pub surface_3: Rgba8,
    pub line: Rgba8,
    pub line_strong: Rgba8,
    pub fg: Rgba8,
    pub fg_muted: Rgba8,
    pub fg_dim: Rgba8,
    pub brand: Rgba8,
    pub brand_bright: Rgba8,
    pub brand_glow: Rgba8,
    pub attn: Rgba8,
    pub attn_glow: Rgba8,
    pub attn_fg: Rgba8,
    pub warn_fg: Rgba8,
    pub ok: Rgba8,
    pub add: Rgba8,
    pub del: Rgba8,
}

#[derive(Debug)]
pub struct ColorScheme {
    pub id: &'static str,
    pub name: &'static str,
    pub appearance: Appearance,
    pub background: Rgba8,
    pub foreground: Rgba8,
    pub cursor: Rgba8,
    pub cursor_accent: Rgba8,
    pub selection_background: Rgba8,
    pub black: Rgba8,
    pub red: Rgba8,
    pub green: Rgba8,
    pub yellow: Rgba8,
    pub blue: Rgba8,
    pub magenta: Rgba8,
    pub cyan: Rgba8,
    pub white: Rgba8,
    pub bright_black: Rgba8,
    pub bright_red: Rgba8,
    pub bright_green: Rgba8,
    pub bright_yellow: Rgba8,
    pub bright_blue: Rgba8,
    pub bright_magenta: Rgba8,
    pub bright_cyan: Rgba8,
    pub bright_white: Rgba8,
}

impl ColorScheme {
    pub fn ansi(&self) -> [Rgba8; 16] {
        [
            self.black,
            self.red,
            self.green,
            self.yellow,
            self.blue,
            self.magenta,
            self.cyan,
            self.white,
            self.bright_black,
            self.bright_red,
            self.bright_green,
            self.bright_yellow,
            self.bright_blue,
            self.bright_magenta,
            self.bright_cyan,
            self.bright_white,
        ]
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Tokens {
    pub bg: Hsla,
    pub bg_sunken: Hsla,
    pub surface_1: Hsla,
    pub surface_2: Hsla,
    pub surface_3: Hsla,
    pub line: Hsla,
    pub line_strong: Hsla,
    pub fg: Hsla,
    pub fg_muted: Hsla,
    pub fg_dim: Hsla,
    pub brand: Hsla,
    pub brand_bright: Hsla,
    pub brand_glow: Hsla,
    pub on_brand: Hsla,
    pub attn: Hsla,
    pub attn_glow: Hsla,
    pub attn_fg: Hsla,
    pub on_attn: Hsla,
    pub warn_fg: Hsla,
    pub ok: Hsla,
    pub add: Hsla,
    pub del: Hsla,
    pub lock: Hsla,
    pub group_red: Hsla,
    pub group_orange: Hsla,
    pub group_yellow: Hsla,
    pub group_green: Hsla,
    pub group_teal: Hsla,
    pub group_blue: Hsla,
    pub group_purple: Hsla,
    pub group_pink: Hsla,
}

const GROUP_RED: Rgba8 = Rgba8::rgb(0xe06c75);
const GROUP_ORANGE: Rgba8 = Rgba8::rgb(0xd19a66);
const GROUP_YELLOW: Rgba8 = Rgba8::rgb(0xe5c07b);
const GROUP_GREEN: Rgba8 = Rgba8::rgb(0x98c379);
const GROUP_TEAL: Rgba8 = Rgba8::rgb(0x56b6c2);
const GROUP_BLUE: Rgba8 = Rgba8::rgb(0x61afef);
const GROUP_PURPLE: Rgba8 = Rgba8::rgb(0xc678dd);
const GROUP_PINK: Rgba8 = Rgba8::rgb(0xe38fc0);

impl Tokens {
    fn from_source(source: &ThemeSource) -> Self {
        Self {
            bg: source.bg.hsla(),
            bg_sunken: source.bg_sunken.hsla(),
            surface_1: source.surface_1.hsla(),
            surface_2: source.surface_2.hsla(),
            surface_3: source.surface_3.hsla(),
            line: source.line.hsla(),
            line_strong: source.line_strong.hsla(),
            fg: source.fg.hsla(),
            fg_muted: source.fg_muted.hsla(),
            fg_dim: source.fg_dim.hsla(),
            brand: source.brand.hsla(),
            brand_bright: source.brand_bright.hsla(),
            brand_glow: source.brand_glow.hsla(),
            on_brand: readable_on(source.brand, &[source.bg, source.fg]).hsla(),
            attn: source.attn.hsla(),
            attn_glow: source.attn_glow.hsla(),
            attn_fg: source.attn_fg.hsla(),
            on_attn: readable_on(source.attn, &[source.fg, source.bg]).hsla(),
            warn_fg: source.warn_fg.hsla(),
            ok: source.ok.hsla(),
            add: source.add.hsla(),
            del: source.del.hsla(),
            lock: GROUP_YELLOW.hsla(),
            group_red: GROUP_RED.hsla(),
            group_orange: GROUP_ORANGE.hsla(),
            group_yellow: GROUP_YELLOW.hsla(),
            group_green: GROUP_GREEN.hsla(),
            group_teal: GROUP_TEAL.hsla(),
            group_blue: GROUP_BLUE.hsla(),
            group_purple: GROUP_PURPLE.hsla(),
            group_pink: GROUP_PINK.hsla(),
        }
    }
}

pub struct OstiaTheme {
    pub source: &'static ThemeSource,
    pub scheme: &'static ColorScheme,
    pub tokens: Tokens,
    pub ui_size: f32,
    pub ui_weight: f32,
}

impl Global for OstiaTheme {}

pub trait UiTheme {
    fn ui_theme(&self) -> &OstiaTheme;

    fn tokens(&self) -> &Tokens {
        &self.ui_theme().tokens
    }
}

impl UiTheme for App {
    fn ui_theme(&self) -> &OstiaTheme {
        self.global::<OstiaTheme>()
    }
}

pub fn themes() -> &'static [ThemeSource] {
    THEMES
}

pub fn color_schemes() -> &'static [ColorScheme] {
    COLOR_SCHEMES
}

fn resolve_theme(id: &str) -> Option<&'static ThemeSource> {
    THEMES
        .iter()
        .find(|theme| theme.id == id)
        .or_else(|| THEMES.first())
}

fn resolve_scheme(source: &ThemeSource) -> Option<&'static ColorScheme> {
    COLOR_SCHEMES
        .iter()
        .find(|scheme| scheme.id == source.color_scheme)
        .or_else(|| COLOR_SCHEMES.first())
}

pub fn set_theme(id: &str, cx: &mut App) {
    let Some(source) = resolve_theme(id) else {
        return;
    };
    let Some(scheme) = resolve_scheme(source) else {
        return;
    };
    let theme = OstiaTheme {
        source,
        scheme,
        tokens: Tokens::from_source(source),
        ui_size: UI_SIZE_DEFAULT,
        ui_weight: UI_WEIGHT_DEFAULT,
    };
    apply_to_kit(&theme, cx);
    cx.set_global(theme);
    cx.refresh_windows();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_theme_names_a_color_scheme_that_exists() {
        for theme in themes() {
            assert!(
                color_schemes()
                    .iter()
                    .any(|scheme| scheme.id == theme.color_scheme),
                "{} has no scheme",
                theme.id
            );
        }
    }

    #[test]
    fn the_six_shipped_themes_are_ported() {
        let ids: Vec<_> = themes().iter().map(|theme| theme.id).collect();
        assert_eq!(
            ids,
            [
                "adeberry",
                "one-dark-vivid",
                "instrument-night",
                "dracula",
                "oxocarbon",
                "ostia-light"
            ]
        );
    }

    #[test]
    fn adeberry_keeps_the_exact_design_system_values() {
        let adeberry = resolve_theme("adeberry").expect("adeberry");
        assert_eq!(adeberry.bg, Rgba8::rgb(0x1d2022));
        assert_eq!(adeberry.surface_3, Rgba8::rgb(0x313537));
        assert_eq!(adeberry.brand, Rgba8::rgb(0x00d8ff));
        assert_eq!(adeberry.line, Rgba8::rgba(0xffffff, 0.07));
    }

    #[test]
    fn an_unknown_theme_falls_back_to_the_first() {
        assert_eq!(resolve_theme("nope").map(|t| t.id), Some("adeberry"));
    }
}
