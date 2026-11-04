#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::LazyLock;

use ostia_base::js::static_regex;
use ostia_model::color_schemes::builtin_color_schemes::builtin_color_schemes;
use ostia_model::theme::color::{normalize_hex, wcag_contrast};
use ostia_model::theme::types::{ANSI_NAMES, Appearance};
use regex::Regex;
use serde_json::{Value, json};

const REQUIRED: [&str; 5] = [
    "background",
    "foreground",
    "cursor",
    "cursorAccent",
    "selectionBackground",
];

static RGBA: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(r"^rgba\([0-9]{1,3}, [0-9]{1,3}, [0-9]{1,3}, (0|1|0?\.[0-9]+)\)$")
});

fn schemes_as_json() -> Vec<Value> {
    builtin_color_schemes()
        .iter()
        .map(|scheme| serde_json::to_value(scheme).unwrap())
        .collect()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

fn color<'a>(scheme: &'a Value, key: &str) -> &'a str {
    scheme["colors"][key]
        .as_str()
        .unwrap_or_else(|| panic!("{}.{key} is not a string", text(scheme, "id")))
}

#[test]
fn has_unique_ids_and_names() {
    let schemes = schemes_as_json();
    let ids: HashSet<&str> = schemes.iter().map(|s| text(s, "id")).collect();
    assert_eq!(ids.len(), schemes.len());
    let names: HashSet<&str> = schemes.iter().map(|s| text(s, "name")).collect();
    assert_eq!(names.len(), schemes.len());
}

#[test]
fn gives_every_scheme_all_16_ansi_colors_and_the_required_keys_as_rrggbb() {
    for scheme in schemes_as_json() {
        let id = text(&scheme, "id");
        for key in ANSI_NAMES.iter().chain(REQUIRED.iter()) {
            let value = color(&scheme, key);
            if *key == "selectionBackground" && RGBA.is_match(value) {
                continue;
            }
            assert_eq!(
                normalize_hex(&json!(value)).as_deref(),
                Some(value),
                "{id}.{key}"
            );
        }
    }
}

#[test]
fn keeps_the_foreground_at_4_5_to_1_or_better_on_the_background() {
    for scheme in schemes_as_json() {
        let contrast = wcag_contrast(color(&scheme, "foreground"), color(&scheme, "background"));
        assert!(contrast >= 4.5, "{}: {contrast}", text(&scheme, "id"));
    }
}

#[test]
fn labels_each_scheme_light_or_dark_by_its_background() {
    for scheme in builtin_color_schemes() {
        let json = serde_json::to_value(scheme).unwrap();
        let light_text = wcag_contrast(color(&json, "background"), "#000000") > 10.0;
        let expected = if light_text {
            Appearance::Light
        } else {
            Appearance::Dark
        };
        assert_eq!(scheme.appearance, expected, "{}", scheme.id);
    }
}

#[test]
fn bundles_a_scheme_of_the_same_appearance_with_every_built_in_ostia_theme() {
    let themes = [
        ("adeberry", Appearance::Dark, "adeberry"),
        ("one-dark-vivid", Appearance::Dark, "one-dark-vivid"),
        ("instrument-night", Appearance::Dark, "instrument-night"),
        ("dracula", Appearance::Dark, "dracula"),
        ("oxocarbon", Appearance::Dark, "oxocarbon"),
        ("ostia-light", Appearance::Light, "ostia-light"),
    ];
    let schemes = builtin_color_schemes();
    for (theme_id, appearance, color_scheme) in themes {
        let scheme = schemes
            .iter()
            .find(|s| s.id == color_scheme)
            .unwrap_or_else(|| panic!("{theme_id} has no scheme {color_scheme}"));
        assert_eq!(scheme.appearance, appearance, "{theme_id}");
    }
}

#[test]
fn ships_the_catalog_through_the_ostia_themes_plugin() {
    let ids: Vec<&str> = builtin_color_schemes()
        .iter()
        .map(|s| s.id.as_str())
        .collect();
    for wanted in [
        "catppuccin-mocha",
        "catppuccin-latte",
        "tokyo-night",
        "gruvbox-dark",
        "gruvbox-light",
        "nord",
        "solarized-dark",
        "solarized-light",
        "rose-pine",
        "kanagawa-wave",
        "everforest-dark",
        "github-dark",
        "github-light",
        "monokai-classic",
    ] {
        assert!(ids.contains(&wanted), "{wanted}");
    }
}

#[test]
fn keeps_the_adeberry_palette_sampled_from_warp_with_its_signature_cyan_cursor() {
    let schemes = schemes_as_json();
    let adeberry = schemes
        .iter()
        .find(|s| text(s, "id") == "adeberry")
        .unwrap();
    assert_eq!(color(adeberry, "background"), "#1d2022");
    assert_eq!(color(adeberry, "cursor"), "#00d8ff");
    assert_eq!(color(adeberry, "brightBlue"), color(adeberry, "cyan"));
}

#[test]
fn matches_the_catalog_the_ts_app_ships_in_order_and_value() {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust/color-schemes.json");
    let expected: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let expected = expected.as_array().unwrap();
    let actual = schemes_as_json();
    assert_eq!(actual.len(), 26);
    assert_eq!(actual.len(), expected.len());
    for (index, (got, want)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(got, want, "scheme {index} {}", text(want, "id"));
    }
}
