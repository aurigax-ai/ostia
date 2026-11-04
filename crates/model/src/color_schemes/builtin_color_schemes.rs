use super::adeberry;
use super::catppuccin_frappe;
use super::catppuccin_latte;
use super::catppuccin_macchiato;
use super::catppuccin_mocha;
use super::dracula;
use super::everforest_dark;
use super::everforest_light;
use super::github_dark;
use super::github_light;
use super::gruvbox_dark;
use super::gruvbox_light;
use super::instrument_night;
use super::kanagawa_wave;
use super::monokai_classic;
use super::nord;
use super::one_dark_vivid;
use super::one_half_light;
use super::ostia_light;
use super::oxocarbon;
use super::rose_ostia;
use super::rose_ostia_dawn;
use super::solarized_dark;
use super::solarized_light;
use super::tokyo_night;
use super::tokyo_night_day;
use crate::theme::types::ColorScheme;
use std::sync::LazyLock;

static BUILTIN_COLOR_SCHEMES: LazyLock<Vec<ColorScheme>> = LazyLock::new(|| {
    vec![
        adeberry::adeberry(),
        one_dark_vivid::one_dark_vivid(),
        instrument_night::instrument_night(),
        dracula::dracula(),
        oxocarbon::oxocarbon(),
        ostia_light::ostia_light(),
        catppuccin_mocha::catppuccin_mocha(),
        catppuccin_macchiato::catppuccin_macchiato(),
        catppuccin_frappe::catppuccin_frappe(),
        catppuccin_latte::catppuccin_latte(),
        tokyo_night::tokyo_night(),
        tokyo_night_day::tokyo_night_day(),
        gruvbox_dark::gruvbox_dark(),
        gruvbox_light::gruvbox_light(),
        nord::nord(),
        solarized_dark::solarized_dark(),
        solarized_light::solarized_light(),
        rose_ostia::rose_ostia(),
        rose_ostia_dawn::rose_ostia_dawn(),
        kanagawa_wave::kanagawa_wave(),
        everforest_dark::everforest_dark(),
        everforest_light::everforest_light(),
        github_dark::github_dark(),
        github_light::github_light(),
        one_half_light::one_half_light(),
        monokai_classic::monokai_classic(),
    ]
});

pub fn builtin_color_schemes() -> &'static [ColorScheme] {
    &BUILTIN_COLOR_SCHEMES
}
