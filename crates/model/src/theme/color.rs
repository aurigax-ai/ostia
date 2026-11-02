use std::collections::HashMap;
use std::sync::LazyLock;

use ostia_base::js::{js_number_text, js_trim, static_regex};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;

use super::css_color::{Rgb, parse_css_color};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    Dark,
    Light,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccentTokens {
    pub brand: String,
    pub brand_bright: String,
    pub brand_glow: String,
}

pub const ACCENT_PRESETS: [&str; 6] = [
    "#00d8ff", "#61afef", "#bd93f9", "#ee5396", "#f2b347", "#58c98c",
];

pub const SELECTION_MIN_DISTANCE: f64 = 0.05;

const PANEL_REACH: f64 = 0.2;
const PANEL_STEP: f64 = 0.02;
const NEUTRAL_CHROMA: f64 = 0.005;
const SELECTION_HUE: f64 = 250.0;
const SELECTION_MAX_CHROMA: f64 = 0.12;
const SELECTION_MAX_SHIFT: f64 = 0.4;
const SELECTION_STEP: f64 = 0.01;
const INK_DARK: &str = "#0b0d10";
const INK_LIGHT: &str = "#ffffff";
const CHROMA_RESOLUTION: f64 = 0.4 / 8192.0;
const BLACK: Rgb = Rgb {
    r: 0.0,
    g: 0.0,
    b: 0.0,
};

static HEX: LazyLock<Regex> = LazyLock::new(|| static_regex(r"(?i)^#([0-9a-f]{3}|[0-9a-f]{6})$"));
static VISIBLE_SELECTIONS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy)]
struct Oklab {
    l: f64,
    a: f64,
    b: f64,
}

#[derive(Clone, Copy)]
struct Oklch {
    l: f64,
    c: f64,
    h: Option<f64>,
}

#[derive(Clone, Copy)]
struct Panel {
    rgb: Rgb,
    lab: Oklab,
}

fn to_rgb(text: &str) -> Rgb {
    parse_css_color(text).map_or(BLACK, |parsed| parsed.rgb)
}

fn linearize(value: f64) -> f64 {
    let magnitude = value.abs();
    if magnitude <= 0.04045 {
        value / 12.92
    } else {
        let sign = if value < 0.0 { -1.0 } else { 1.0 };
        sign * ((magnitude + 0.055) / 1.055).powf(2.4)
    }
}

fn delinearize(value: f64) -> f64 {
    let magnitude = value.abs();
    if magnitude > 0.0031308 {
        let sign = if value < 0.0 { -1.0 } else { 1.0 };
        sign * (1.055 * magnitude.powf(1.0 / 2.4) - 0.055)
    } else {
        value * 12.92
    }
}

fn rgb_to_oklab(rgb: Rgb) -> Oklab {
    let (r, g, b) = (linearize(rgb.r), linearize(rgb.g), linearize(rgb.b));
    let long = (0.412221469470763 * r + 0.5363325372617348 * g + 0.0514459932675022 * b).cbrt();
    let medium = (0.2119034958178252 * r + 0.6806995506452344 * g + 0.1073969535369406 * b).cbrt();
    let short = (0.0883024591900564 * r + 0.2817188391361215 * g + 0.6299787016738222 * b).cbrt();
    Oklab {
        l: 0.210454268309314 * long + 0.7936177747023054 * medium - 0.0040720430116193 * short,
        a: 1.9779985324311684 * long - 2.42859224204858 * medium + 0.450593709617411 * short,
        b: 0.0259040424655478 * long + 0.7827717124575296 * medium - 0.8086757549230774 * short,
    }
}

fn oklab_to_rgb(lab: Oklab) -> Rgb {
    let long = (lab.l + 0.3963377773761749 * lab.a + 0.2158037573099136 * lab.b).powf(3.0);
    let medium = (lab.l - 0.1055613458156586 * lab.a - 0.0638541728258133 * lab.b).powf(3.0);
    let short = (lab.l - 0.0894841775298119 * lab.a - 1.2914855480194092 * lab.b).powf(3.0);
    Rgb {
        r: delinearize(
            4.076741636075957 * long - 3.3077115392580616 * medium + 0.2309699031821044 * short,
        ),
        g: delinearize(
            -1.2684379732850317 * long + 2.6097573492876887 * medium - 0.3413193760026573 * short,
        ),
        b: delinearize(
            -0.0041960761386756 * long - 0.7034186179359362 * medium + 1.7076146940746117 * short,
        ),
    }
}

fn normalize_degrees(hue: f64) -> f64 {
    let wrapped = hue % 360.0;
    if wrapped < 0.0 {
        wrapped + 360.0
    } else {
        wrapped
    }
}

fn oklab_to_oklch(lab: Oklab) -> Oklch {
    let chroma = (lab.a * lab.a + lab.b * lab.b).sqrt();
    Oklch {
        l: lab.l,
        c: chroma,
        h: (chroma != 0.0)
            .then(|| normalize_degrees(lab.b.atan2(lab.a) * 180.0 / std::f64::consts::PI)),
    }
}

fn oklch_to_oklab(lch: Oklch) -> Oklab {
    let radians = (lch.h.unwrap_or(0.0) / 180.0) * std::f64::consts::PI;
    if lch.c == 0.0 {
        Oklab {
            l: lch.l,
            a: 0.0,
            b: 0.0,
        }
    } else {
        Oklab {
            l: lch.l,
            a: lch.c * radians.cos(),
            b: lch.c * radians.sin(),
        }
    }
}

fn oklch_to_rgb(lch: Oklch) -> Rgb {
    oklab_to_rgb(oklch_to_oklab(lch))
}

fn displayable(rgb: Rgb) -> bool {
    [rgb.r, rgb.g, rgb.b]
        .iter()
        .all(|channel| (0.0..=1.0).contains(channel))
}

fn clip(rgb: Rgb) -> Rgb {
    let bound = |channel: f64| channel.clamp(0.0, 1.0);
    Rgb {
        r: bound(rgb.r),
        g: bound(rgb.g),
        b: bound(rgb.b),
    }
}

fn clamp_chroma(lch: Oklch) -> Rgb {
    let rgb = oklch_to_rgb(lch);
    if displayable(rgb) {
        return rgb;
    }
    let mut clamped = Oklch { c: 0.0, ..lch };
    if !displayable(oklch_to_rgb(clamped)) {
        return clip(oklch_to_rgb(clamped));
    }
    let mut start = 0.0;
    let mut end = lch.c;
    let mut last_good = clamped.c;
    while end - start > CHROMA_RESOLUTION {
        clamped.c = start + (end - start) * 0.5;
        if displayable(oklch_to_rgb(clamped)) {
            last_good = clamped.c;
            start = clamped.c;
        } else {
            end = clamped.c;
        }
    }
    if displayable(oklch_to_rgb(clamped)) {
        oklch_to_rgb(clamped)
    } else {
        oklch_to_rgb(Oklch {
            c: last_good,
            ..clamped
        })
    }
}

fn format_hex(rgb: Rgb) -> String {
    let byte = |channel: f64| {
        let clamped = if channel.is_nan() {
            0.0
        } else {
            channel.clamp(0.0, 1.0)
        };
        (clamped * 255.0).round() as u32
    };
    format!("#{:02x}{:02x}{:02x}", byte(rgb.r), byte(rgb.g), byte(rgb.b))
}

fn lerp_rgb(from: Rgb, to: Rgb, amount: f64) -> Rgb {
    let t = amount.clamp(0.0, 1.0);
    let lerp = |a: f64, b: f64| a + t * (b - a);
    Rgb {
        r: lerp(from.r, to.r),
        g: lerp(from.g, to.g),
        b: lerp(from.b, to.b),
    }
}

fn distance(left: Oklab, right: Oklab) -> f64 {
    ((left.l - right.l).powi(2) + (left.a - right.a).powi(2) + (left.b - right.b).powi(2)).sqrt()
}

pub fn normalize_hex(input: &Value) -> Option<String> {
    normalize_hex_text(input.as_str()?)
}

fn normalize_hex_text(text: &str) -> Option<String> {
    let value = js_trim(text);
    if !HEX.is_match(value) {
        return None;
    }
    parse_css_color(value).map(|parsed| format_hex(parsed.rgb))
}

pub fn mix(from: &str, to: &str, amount: f64) -> String {
    format_hex(lerp_rgb(to_rgb(from), to_rgb(to), amount))
}

pub fn wcag_luminance(color: &str) -> f64 {
    let rgb = to_rgb(color);
    0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b)
}

pub fn wcag_contrast(first: &str, second: &str) -> f64 {
    let (left, right) = (wcag_luminance(first), wcag_luminance(second));
    (left.max(right) + 0.05) / (left.min(right) + 0.05)
}

pub fn oklab_distance(first: &str, second: &str) -> f64 {
    distance(rgb_to_oklab(to_rgb(first)), rgb_to_oklab(to_rgb(second)))
}

pub fn oklch_hue(color: &str) -> Option<f64> {
    parse_css_color(color).and_then(|parsed| oklab_to_oklch(rgb_to_oklab(parsed.rgb)).h)
}

fn with_alpha(hex: &str, alpha: f64) -> String {
    let Some(parsed) = parse_css_color(hex) else {
        return hex.to_owned();
    };
    let rgb = parsed.rgb;
    let byte = |channel: f64| {
        let clamped = if channel.is_nan() {
            0.0
        } else {
            channel.clamp(0.0, 1.0)
        };
        (clamped * 255.0).round() as u32
    };
    let (r, g, b) = (byte(rgb.r), byte(rgb.g), byte(rgb.b));
    if alpha == 1.0 {
        format!("rgb({r}, {g}, {b})")
    } else {
        let rounded = (alpha.clamp(0.0, 1.0) * 100.0).round() / 100.0;
        format!("rgba({r}, {g}, {b}, {})", js_number_text(rounded))
    }
}

pub fn ensure_contrast(hex: &str, background: &str, minimum: f64) -> String {
    let target = if wcag_luminance(background) > 0.4 {
        "#000000"
    } else {
        "#ffffff"
    };
    for step in 0..=20 {
        let candidate = mix(hex, target, f64::from(step) / 20.0);
        if wcag_contrast(&candidate, background) >= minimum {
            return candidate;
        }
    }
    target.to_owned()
}

pub fn readable_on(fill: &str, preferred: &[&str]) -> String {
    let Some(base) = normalize_hex_text(fill) else {
        return INK_DARK.to_owned();
    };
    for candidate in preferred {
        if let Some(hex) = normalize_hex_text(candidate)
            && wcag_contrast(&hex, &base) >= 4.5
        {
            return hex;
        }
    }
    if wcag_contrast(&base, INK_DARK) >= wcag_contrast(&base, INK_LIGHT) {
        INK_DARK.to_owned()
    } else {
        INK_LIGHT.to_owned()
    }
}

pub fn derive_accent(hex: &str, appearance: Appearance, background: &str) -> AccentTokens {
    let brand = ensure_contrast(hex, background, 4.5);
    let dark = appearance == Appearance::Dark;
    let brand_bright = if dark {
        mix(&brand, "#ffffff", 0.35)
    } else {
        mix(&brand, "#000000", 0.3)
    };
    let brand_glow = with_alpha(&brand, if dark { 0.18 } else { 0.14 });
    AccentTokens {
        brand,
        brand_bright,
        brand_glow,
    }
}

fn over_background(color: &str, background: &str) -> Rgb {
    let parsed = parse_css_color(color).or_else(|| parse_css_color(background));
    let base = parse_css_color(background);
    match (parsed, base) {
        (Some(parsed), Some(base)) => lerp_rgb(base.rgb, parsed.rgb, parsed.alpha.unwrap_or(1.0)),
        _ => BLACK,
    }
}

fn background_lightness(background: &str) -> f64 {
    oklab_to_oklch(rgb_to_oklab(to_rgb(background))).l
}

fn panels_near(background: &str) -> Vec<Panel> {
    let lightness = background_lightness(background);
    let base = to_rgb(background);
    let mut panels = vec![Panel {
        rgb: base,
        lab: rgb_to_oklab(base),
    }];
    let mut offset = -PANEL_REACH;
    while offset <= PANEL_REACH + 1e-9 {
        let l = (lightness + offset).clamp(0.0, 1.0);
        let lab = Oklab { l, a: 0.0, b: 0.0 };
        panels.push(Panel {
            rgb: oklab_to_rgb(lab),
            lab,
        });
        offset += PANEL_STEP;
    }
    panels
}

pub fn selection_visibility(selection: &str, background: &str) -> f64 {
    let selected = over_background(selection, background);
    let selected_lab = rgb_to_oklab(selected);
    let mut worst = f64::INFINITY;
    for panel in panels_near(background) {
        let replaced = distance(selected_lab, panel.lab);
        let blended = distance(rgb_to_oklab(lerp_rgb(panel.rgb, selected, 0.5)), panel.lab);
        worst = worst.min(replaced).min(blended);
    }
    worst
}

pub fn visible_selection(selection: &str, background: &str) -> String {
    let key = format!("{selection}|{background}");
    if let Some(known) = VISIBLE_SELECTIONS.lock().get(&key) {
        return known.clone();
    }
    let visible = find_visible_selection(selection, background);
    VISIBLE_SELECTIONS.lock().insert(key, visible.clone());
    visible
}

fn find_visible_selection(selection: &str, background: &str) -> String {
    if selection_visibility(selection, background) >= SELECTION_MIN_DISTANCE {
        return selection.to_owned();
    }
    let base = oklab_to_oklch(rgb_to_oklab(over_background(selection, background)));
    let hue = match base.h {
        Some(hue) if base.c >= NEUTRAL_CHROMA => hue,
        _ => SELECTION_HUE,
    };
    let away = if background_lightness(background) < 0.5 {
        1.0
    } else {
        -1.0
    };
    let mut candidate = selection.to_owned();
    let mut shift = 0.0;
    while shift <= SELECTION_MAX_SHIFT + 1e-9 {
        let l = (base.l + away * shift).clamp(0.0, 1.0);
        let mut c = base.c;
        while c <= SELECTION_MAX_CHROMA + 1e-9 {
            candidate = format_hex(clamp_chroma(Oklch { l, c, h: Some(hue) }));
            if selection_visibility(&candidate, background) >= SELECTION_MIN_DISTANCE {
                return candidate;
            }
            c += SELECTION_STEP;
        }
        shift += SELECTION_STEP;
    }
    candidate
}
