use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, px};

use crate::color::mix_over;
use crate::theme::{Appearance, OstiaTheme};
use crate::tokens::{
    FONT_CODE, FONT_UI, MOTION_BASE, MOTION_FAST, MOTION_PANEL, RADIUS_LG, RADIUS_SM,
};

const REM_SIZE: f32 = 16.;
const SCROLLBAR_THUMB_HOVER: f32 = 0.26;

pub(crate) fn apply_to_kit(ostia: &OstiaTheme, cx: &mut App) {
    let t = ostia.tokens;
    let mode = match ostia.source.appearance {
        Appearance::Dark => ThemeMode::Dark,
        Appearance::Light => ThemeMode::Light,
    };
    Theme::change(mode, None, cx);
    Theme::update(cx, |theme| {
        theme.font_family = FONT_UI.into();
        theme.mono_font_family = FONT_CODE.into();
        theme.font_size = px(REM_SIZE);
        theme.mono_font_size = px(ostia.ui_size);
        theme.radius = RADIUS_SM;
        theme.radius_lg = RADIUS_LG;
        theme.shadow = false;
        theme.focus_ring = true;
        theme.motion.duration_fast = MOTION_FAST;
        theme.motion.duration_normal = MOTION_BASE;
        theme.motion.duration_slow = MOTION_PANEL;

        let c = &mut theme.colors;
        c.background = t.bg;
        c.foreground = t.fg;
        c.popover = t.surface_2;
        c.popover_foreground = t.fg;
        c.primary = t.brand;
        c.primary_hover = t.brand.opacity(0.8);
        c.primary_active = t.brand.opacity(0.8);
        c.primary_foreground = t.on_brand;
        c.secondary = t.surface_2;
        c.secondary_hover = t.surface_3;
        c.secondary_active = t.surface_3;
        c.secondary_foreground = t.fg;
        c.muted = t.surface_2;
        c.muted_foreground = t.fg_muted;
        c.accent = t.surface_3;
        c.accent_foreground = t.fg;
        c.danger = t.attn_fg;
        c.danger_hover = t.attn_fg.opacity(0.8);
        c.danger_active = t.attn_fg.opacity(0.8);
        c.danger_foreground = t.on_attn;
        c.warning = t.warn_fg;
        c.warning_hover = t.warn_fg.opacity(0.8);
        c.warning_active = t.warn_fg.opacity(0.8);
        c.warning_foreground = t.bg;
        c.success = t.ok;
        c.success_hover = t.ok.opacity(0.8);
        c.success_active = t.ok.opacity(0.8);
        c.success_foreground = t.bg;
        c.info = t.fg_muted;
        c.info_hover = t.fg;
        c.info_active = t.fg;
        c.info_foreground = t.bg;
        c.border = t.line;
        c.input = t.line_strong;
        c.ring = t.brand;
        c.caret = t.fg;
        c.selection = t.brand_glow;
        c.drag_border = t.brand;
        c.drop_target = t.brand_glow;
        c.link = t.fg_muted;
        c.link_hover = t.fg;
        c.link_active = t.fg;
        c.list = t.surface_2;
        c.list_active = t.surface_3;
        c.list_active_border = t.line_strong;
        c.list_even = t.surface_2;
        c.list_head = t.surface_2;
        c.list_hover = t.surface_3;
        c.overlay = t.bg_sunken.opacity(0.6);
        c.progress_bar = t.brand;
        c.scrollbar = gpui_kit::transparent_black();
        c.scrollbar_thumb = t.line_strong;
        c.scrollbar_thumb_hover = mix_over(t.fg, SCROLLBAR_THUMB_HOVER);
        c.sidebar = t.surface_1;
        c.sidebar_foreground = t.fg;
        c.sidebar_accent = t.surface_2;
        c.sidebar_accent_foreground = t.fg;
        c.sidebar_border = t.line;
        c.sidebar_primary = t.brand;
        c.sidebar_primary_foreground = t.on_brand;
        c.switch = t.line_strong;
        c.switch_thumb = t.fg;
        c.slider_bar = t.brand;
        c.slider_thumb = t.fg;
        c.tab = t.surface_2;
        c.tab_active = t.surface_1;
        c.tab_active_foreground = t.fg;
        c.tab_bar = t.surface_2;
        c.tab_bar_segmented = t.surface_2;
        c.tab_foreground = t.fg_muted;
        c.table = t.surface_1;
        c.table_active = t.surface_3;
        c.table_active_border = t.line_strong;
        c.table_even = t.surface_1;
        c.table_head = t.surface_2;
        c.table_head_foreground = t.fg_muted;
        c.table_hover = t.surface_2;
        c.table_row_border = t.line;
        c.title_bar = t.surface_1;
        c.title_bar_border = t.line;
        c.status_bar = t.surface_1;
        c.status_bar_border = t.line;
        c.window_border = t.line;
    });
}
