#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::theme::color::{
    ACCENT_PRESETS, Appearance, SELECTION_MIN_DISTANCE, derive_accent, ensure_contrast, mix,
    normalize_hex, oklab_distance, oklch_hue, readable_on, selection_visibility, visible_selection,
    wcag_contrast, wcag_luminance,
};
use serde_json::{Value, json};

fn close_to(actual: f64, expected: f64, digits: i32) -> bool {
    (actual - expected).abs() < 10f64.powi(-digits) / 2.0
}

#[test]
fn accepts_rgb_and_rrggbb_in_any_case_and_returns_lowercase_rrggbb() {
    assert_eq!(normalize_hex(&json!("#F80")).as_deref(), Some("#ff8800"));
    assert_eq!(
        normalize_hex(&json!(" #00D8FF ")).as_deref(),
        Some("#00d8ff")
    );
}

#[test]
fn rejects_everything_else() {
    let bad: [Value; 9] = [
        json!(""),
        json!("ff8800"),
        json!("#ff88"),
        json!("#ff88000"),
        json!("#gggggg"),
        json!("red"),
        json!("rgb(1,2,3)"),
        json!(5),
        Value::Null,
    ];
    for value in bad {
        assert_eq!(normalize_hex(&value), None, "{value}");
    }
}

#[test]
fn is_21_for_black_on_white_and_1_for_identical_colors() {
    assert!(close_to(wcag_contrast("#000000", "#ffffff"), 21.0, 5));
    assert!(close_to(wcag_contrast("#123456", "#123456"), 1.0, 5));
    assert!(close_to(wcag_luminance("#ffffff"), 1.0, 5));
}

#[test]
fn keeps_a_color_that_already_reads_and_darkens_one_that_does_not_on_a_light_background() {
    assert_eq!(ensure_contrast("#0b62c4", "#f6f7f9", 4.5), "#0b62c4");
    let adjusted = ensure_contrast("#f2b347", "#f6f7f9", 4.5);
    assert_ne!(adjusted, "#f2b347");
    assert!(wcag_contrast(&adjusted, "#f6f7f9") >= 4.5);
}

#[test]
fn lightens_a_color_that_is_too_dark_on_a_dark_background() {
    let adjusted = ensure_contrast("#1a2b5c", "#1d2022", 4.5);
    assert!(wcag_contrast(&adjusted, "#1d2022") >= 4.5);
}

#[test]
fn picks_dark_text_for_a_light_fill_like_f2b347_and_light_text_for_a_dark_fill() {
    assert_eq!(readable_on("#f2b347", &["#1d2022", "#e3edf5"]), "#1d2022");
    assert_eq!(readable_on("#1f3a8a", &["#1d2022", "#e3edf5"]), "#e3edf5");
}

#[test]
fn keeps_the_first_preferred_color_that_reads_at_4_5_to_1() {
    assert_eq!(readable_on("#0b62c4", &["#f6f7f9", "#1c2127"]), "#f6f7f9");
}

#[test]
fn falls_back_to_near_black_or_white_when_no_preferred_color_reads() {
    assert_eq!(readable_on("#ffcc00", &["#ffffff", "#ffee88"]), "#0b0d10");
    assert_eq!(
        readable_on("#5a2d82", &["#3a3a3a", "not-a-color"]),
        "#ffffff"
    );
}

#[test]
fn falls_back_to_near_black_when_the_fill_is_not_a_color() {
    assert_eq!(readable_on("not-a-color", &["#ffffff"]), "#0b0d10");
}

#[test]
fn derives_brand_bright_and_glow_tokens_from_the_accent_on_a_dark_theme() {
    let tokens = derive_accent("#ff8800", Appearance::Dark, "#1d2022");
    assert_eq!(tokens.brand, "#ff8800");
    assert!(wcag_luminance(&tokens.brand_bright) > wcag_luminance(&tokens.brand));
    assert_eq!(tokens.brand_glow, "rgba(255, 136, 0, 0.18)");
}

#[test]
fn makes_the_bright_token_darker_on_a_light_theme() {
    let tokens = derive_accent("#0b62c4", Appearance::Light, "#f6f7f9");
    assert!(wcag_luminance(&tokens.brand_bright) < wcag_luminance(&tokens.brand));
}

#[test]
fn uses_a_lower_glow_alpha_on_a_light_theme() {
    let tokens = derive_accent("#0b62c4", Appearance::Light, "#f6f7f9");
    assert_eq!(tokens.brand_glow, "rgba(11, 98, 196, 0.14)");
}

#[test]
fn gives_every_preset_a_readable_brand_and_button_text_on_both_built_in_backgrounds() {
    for preset in ACCENT_PRESETS {
        for (appearance, bg) in [
            (Appearance::Dark, "#1d2022"),
            (Appearance::Light, "#f6f7f9"),
        ] {
            let tokens = derive_accent(preset, appearance, bg);
            assert!(
                wcag_contrast(&tokens.brand, bg) >= 4.5,
                "{preset} {appearance:?}"
            );
            let on_brand = readable_on(&tokens.brand, &[bg]);
            assert!(
                wcag_contrast(&on_brand, &tokens.brand) >= 4.5,
                "{preset} button"
            );
        }
    }
}

#[test]
fn keeps_a_selection_that_already_stands_out_from_the_background_and_nearby_panels() {
    assert_eq!(visible_selection("#f5e0dc", "#1e1e2e"), "#f5e0dc");
}

#[test]
fn makes_a_grey_selection_visible_over_the_grey_panel_an_agent_cli_paints() {
    const CLAUDE_USER_MESSAGE: &str = "#373737";
    assert!(selection_visibility("#393939", "#161616") < SELECTION_MIN_DISTANCE);
    let visible = visible_selection("#393939", "#161616");
    assert!(selection_visibility(&visible, "#161616") >= SELECTION_MIN_DISTANCE);
    let dom_selected = visible.clone();
    let webgl_selected = mix(CLAUDE_USER_MESSAGE, &visible, 0.5);
    for selected in [dom_selected, webgl_selected] {
        assert!(oklab_distance(&selected, CLAUDE_USER_MESSAGE) >= SELECTION_MIN_DISTANCE);
    }
}

#[test]
fn tints_a_neutral_selection_blue_and_keeps_the_hue_of_a_tinted_one() {
    let neutral = visible_selection("#393939", "#161616");
    assert!(close_to(oklch_hue(&neutral).unwrap(), 250.0, 0));
    let tinted = "rgba(242, 179, 71, 0.22)";
    let hue_before = oklch_hue(&mix("#0a0c12", "rgb(242, 179, 71)", 0.22)).unwrap_or(0.0);
    let hue_after = oklch_hue(&visible_selection(tinted, "#0a0c12")).unwrap();
    assert!(close_to(hue_after, hue_before, -1));
}

#[test]
fn works_for_light_backgrounds() {
    let visible = visible_selection("#dfdad9", "#faf4ed");
    assert!(selection_visibility(&visible, "#faf4ed") >= SELECTION_MIN_DISTANCE);
}
