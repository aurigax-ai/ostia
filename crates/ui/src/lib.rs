extern crate gpui_kit as gpui;

pub mod assets;
pub mod color;
pub mod components;
pub mod focus;
pub mod icons;
pub mod theme;
mod theme_bridge;
mod theme_data;
pub mod tokens;

use gpui_kit::{App, Application};

pub const DEFAULT_THEME: &str = "adeberry";

pub fn application() -> Application {
    gpui_kit::application().with_assets(assets::AppAssets)
}

pub fn init(cx: &mut App) {
    gpui_kit::init(cx);
    assets::load_fonts(cx);
    theme::set_theme(DEFAULT_THEME, cx);
}
