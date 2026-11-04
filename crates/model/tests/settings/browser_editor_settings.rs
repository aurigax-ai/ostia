#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use ostia_model::settings::browser_editor_settings::{
    AUTO_SAVE_DELAY_MS, BrowserSettings, DIFF_LAYOUTS, EditorSettings, OPEN_FILES_IN,
    SEARCH_ENGINES, SearchEngine, TAB_WIDTHS, ZOOM_MAX, ZOOM_MIN, clamp_zoom,
    is_valid_search_template, parse_browser_settings, parse_editor_settings, search_url,
};
use serde_json::{Value, json};

fn as_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn browser_defaults() -> Value {
    as_json(&BrowserSettings::default())
}

fn editor_defaults() -> Value {
    as_json(&EditorSettings::default())
}

fn with(defaults: Value, changes: Value) -> Value {
    let mut merged = defaults;
    for (key, value) in changes.as_object().unwrap() {
        merged[key] = value.clone();
    }
    merged
}

fn expected() -> Value {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust/browser-editor-settings.json");
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}

fn engine_settings(engine: &str, custom: &str) -> BrowserSettings {
    let parsed = parse_browser_settings(&json!({
        "searchEngine": engine,
        "customSearchUrl": custom,
    }));
    assert_eq!(as_json(&parsed)["searchEngine"], engine);
    parsed
}

#[test]
fn accepts_http_and_https_templates_containing_query() {
    assert!(is_valid_search_template("https://example.com/s?q={query}"));
    assert!(is_valid_search_template("http://127.0.0.1:8080/{query}"));
}

#[test]
fn rejects_templates_without_query() {
    assert!(!is_valid_search_template("https://example.com/s?q="));
}

#[test]
fn rejects_other_protocols_and_garbage() {
    assert!(!is_valid_search_template("javascript:alert({query})"));
    assert!(!is_valid_search_template("file:///tmp/{query}"));
    assert!(!is_valid_search_template("{query}"));
}

#[test]
fn fills_the_chosen_engine_template_with_the_encoded_query() {
    let settings = BrowserSettings {
        search_engine: SearchEngine::Duckduckgo,
        ..BrowserSettings::default()
    };
    assert_eq!(
        search_url(&settings, "a b&c"),
        "https://duckduckgo.com/?q=a%20b%26c"
    );
}

#[test]
fn uses_the_custom_template_when_valid() {
    let settings = BrowserSettings {
        search_engine: SearchEngine::Custom,
        custom_search_url: "https://s.test/?term={query}".to_owned(),
        ..BrowserSettings::default()
    };
    assert_eq!(search_url(&settings, "x y"), "https://s.test/?term=x%20y");
}

#[test]
fn uses_google_when_the_custom_template_is_invalid() {
    let settings = BrowserSettings {
        search_engine: SearchEngine::Custom,
        custom_search_url: "ftp://s.test/{query}".to_owned(),
        ..BrowserSettings::default()
    };
    assert_eq!(
        search_url(&settings, "x"),
        "https://www.google.com/search?q=x"
    );
}

#[test]
fn keeps_zoom_within_50_to_300_percent() {
    assert_eq!(clamp_zoom(10.0), 50);
    assert_eq!(clamp_zoom(999.0), 300);
    assert_eq!(clamp_zoom(125.4), 125);
    assert_eq!(clamp_zoom(f64::NAN), 100);
}

#[test]
fn returns_defaults_for_non_objects() {
    assert_eq!(
        as_json(&parse_browser_settings(&Value::Null)),
        browser_defaults()
    );
    assert_eq!(
        as_json(&parse_browser_settings(&json!([]))),
        browser_defaults()
    );
}

#[test]
fn keeps_valid_values_and_drops_invalid_ones() {
    assert_eq!(
        as_json(&parse_browser_settings(&json!({
            "searchEngine": "kagi",
            "defaultZoom": 500,
            "attachCaptureImage": false,
        }))),
        with(
            browser_defaults(),
            json!({"searchEngine": "kagi", "defaultZoom": 300, "attachCaptureImage": false}),
        )
    );
    assert_eq!(
        as_json(&parse_browser_settings(&json!({
            "searchEngine": "nope",
            "defaultZoom": "big",
            "attachCaptureImage": 1,
        }))),
        browser_defaults()
    );
    assert_eq!(browser_defaults()["attachCaptureImage"], json!(true));
}

#[test]
fn returns_defaults_for_missing_or_invalid_values() {
    assert_eq!(
        as_json(&parse_editor_settings(&Value::Null)),
        editor_defaults()
    );
    assert_eq!(
        as_json(&parse_editor_settings(&json!({
            "tabSize": 3,
            "wordWrap": "bounded",
            "autoSave": "always",
        }))),
        editor_defaults()
    );
}

#[test]
fn keeps_valid_values() {
    let custom = json!({
        "wordWrap": "on",
        "lineNumbers": "relative",
        "tabSize": 8,
        "insertSpaces": false,
        "autoSave": "afterDelay",
        "formatOnSave": true,
        "openFilesIn": "split",
        "theme": "rose-pine",
        "diffLayout": "inline",
        "diffIgnoreWhitespace": true,
    });
    assert_eq!(as_json(&parse_editor_settings(&custom)), custom);
}

#[test]
fn lets_a_diff_pick_its_layout_unless_set_otherwise() {
    let parsed = |raw: Value| as_json(&parse_editor_settings(&raw));
    assert_eq!(parsed(json!({}))["diffLayout"], "auto");
    assert_eq!(
        parsed(json!({"diffLayout": "stacked"}))["diffLayout"],
        "auto"
    );
    assert_eq!(
        parsed(json!({"diffLayout": "sideBySide"}))["diffLayout"],
        "sideBySide"
    );
    assert_eq!(parsed(json!({}))["diffIgnoreWhitespace"], false);
    assert_eq!(
        parsed(json!({"diffIgnoreWhitespace": "yes"}))["diffIgnoreWhitespace"],
        false
    );
}

#[test]
fn links_the_editor_colors_to_the_ostia_theme_by_default() {
    assert_eq!(editor_defaults()["theme"], "match");
    assert_eq!(
        as_json(&parse_editor_settings(&json!({"theme": null})))["theme"],
        "match"
    );
}

#[test]
fn lists_the_choices_and_limits_the_settings_page_offers() {
    assert_eq!(
        SEARCH_ENGINES,
        ["google", "duckduckgo", "bing", "kagi", "custom"]
    );
    assert_eq!((ZOOM_MIN, ZOOM_MAX), (50, 300));
    assert_eq!(TAB_WIDTHS, [2, 4, 8]);
    assert_eq!(OPEN_FILES_IN, ["tab", "split"]);
    assert_eq!(DIFF_LAYOUTS, ["auto", "sideBySide", "inline"]);
    assert_eq!(AUTO_SAVE_DELAY_MS, 1000);
}

#[test]
fn defaults_match_the_ts_defaults() {
    let table = expected();
    assert_eq!(browser_defaults(), table["browserDefaults"]);
    assert_eq!(editor_defaults(), table["editorDefaults"]);
}

#[test]
fn builds_every_search_url_the_ts_app_builds() {
    let table = expected();
    let rows = table["searchUrls"].as_array().unwrap();
    assert!(rows.len() > 500);
    for row in rows {
        let settings = engine_settings(
            row["searchEngine"].as_str().unwrap(),
            row["customSearchUrl"].as_str().unwrap(),
        );
        assert_eq!(
            search_url(&settings, row["query"].as_str().unwrap()),
            row["url"].as_str().unwrap(),
            "{row}"
        );
    }
}

#[test]
fn judges_every_search_template_as_the_ts_app_does() {
    let table = expected();
    let rows = table["validTemplates"].as_array().unwrap();
    assert!(rows.len() >= 15);
    for row in rows {
        assert_eq!(
            is_valid_search_template(row["template"].as_str().unwrap()),
            row["valid"].as_bool().unwrap(),
            "{row}"
        );
    }
}

#[test]
fn rounds_and_clamps_zoom_as_the_ts_app_does() {
    let table = expected();
    let rows = table["zoom"].as_array().unwrap();
    assert!(rows.len() >= 15);
    for row in rows {
        assert_eq!(
            u64::from(clamp_zoom(row["input"].as_f64().unwrap())),
            row["output"].as_u64().unwrap(),
            "{row}"
        );
    }
    for row in table["zoomNonFinite"].as_array().unwrap() {
        let input = match row["input"].as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => panic!("unknown input {other}"),
        };
        assert_eq!(
            u64::from(clamp_zoom(input)),
            row["output"].as_u64().unwrap(),
            "{row}"
        );
    }
}

#[test]
fn parses_every_stored_browser_value_as_the_ts_app_does() {
    let table = expected();
    let rows = table["browser"].as_array().unwrap();
    assert!(rows.len() >= 10);
    for row in rows {
        assert_eq!(
            as_json(&parse_browser_settings(&row["input"])),
            row["output"],
            "{row}"
        );
    }
}

#[test]
fn parses_every_stored_editor_value_as_the_ts_app_does() {
    let table = expected();
    let rows = table["editor"].as_array().unwrap();
    assert!(rows.len() >= 10);
    for row in rows {
        assert_eq!(
            as_json(&parse_editor_settings(&row["input"])),
            row["output"],
            "{row}"
        );
    }
}
