#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use ostia_base::Platform;
use ostia_model::theme::ui_fonts::{
    SurfaceFont, UI_FONT_FALLBACK, UiFontSettings, code_font_fallback, code_font_stack, font_stack,
    terminal_font_fallback, terminal_font_stack, ui_font_stack, ui_font_variables,
};
use serde_json::Value;

fn surface(family: &str, size: f64, weight: u32) -> SurfaceFont {
    SurfaceFont {
        family: family.to_owned(),
        size,
        weight,
    }
}

fn fonts() -> UiFontSettings {
    UiFontSettings {
        ui: surface("Inter Variable", 14.0, 500),
        editor: surface("Bitstream Vera Sans Mono", 14.0, 500),
    }
}

fn fixture() -> Value {
    let file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/rust/ui-fonts.json");
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}

#[test]
fn turns_the_ui_and_editor_settings_into_the_ui_and_code_font_tokens() {
    let variables = ui_font_variables(&fonts(), Platform::Linux);
    let pairs: Vec<(&str, &str)> = variables
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let ui = format!("\"Inter Variable\", {UI_FONT_FALLBACK}");
    let code = format!(
        "\"Bitstream Vera Sans Mono\", {}",
        code_font_fallback(false)
    );
    assert_eq!(
        pairs,
        vec![
            ("--font-ui", ui.as_str()),
            ("--font-code", code.as_str()),
            ("--font-ui-size", "14px"),
            ("--font-ui-weight", "500"),
        ]
    );
}

#[test]
fn writes_the_tokens_on_the_root_element() {
    let variables = ui_font_variables(&fonts(), Platform::Linux);
    assert!(variables["--font-code"].contains("\"Bitstream Vera Sans Mono\""));
    assert_eq!(variables["--font-ui-size"], "14px");
}

#[test]
fn the_ui_settings_lists_keycaps_chat_code_and_the_git_panel_use_the_chosen_ui_and_code_fonts() {
    let chosen = UiFontSettings {
        ui: surface("Geist Variable", 14.0, 400),
        editor: surface("Geist Mono Variable", 13.0, 400),
    };
    let variables = ui_font_variables(&chosen, Platform::Linux);
    assert!(variables["--font-ui"].starts_with("\"Geist Variable\", "));
    assert!(variables["--font-code"].starts_with("\"Geist Mono Variable\", "));
    assert_eq!(variables["--font-ui-size"], "14px");
}

#[test]
fn quotes_the_family_and_keeps_the_bundled_fallbacks_after_it() {
    let fallback = terminal_font_fallback(false);
    assert_eq!(
        font_stack("MesloLGS NF", &fallback),
        format!("\"MesloLGS NF\", {fallback}")
    );
}

#[test]
fn strips_characters_that_could_break_out_of_the_declaration() {
    let fallback = code_font_fallback(false);
    assert_eq!(
        font_stack("Evil\"; } * {", &fallback),
        format!("\"Evil  *\", {fallback}")
    );
    assert_eq!(font_stack("  ", &fallback), fallback);
}

#[test]
fn tries_latin_monos_before_cjk_fonts_so_a_missing_family_keeps_latin_cell_metrics() {
    for mac in [false, true] {
        for stack in [terminal_font_fallback(mac), code_font_fallback(mac)] {
            let latin = stack.find("\"DejaVu Sans Mono\"").unwrap();
            let cjk = stack.find("CJK").unwrap();
            assert!(latin < cjk, "{stack}");
        }
    }
}

#[test]
fn adds_the_built_in_ping_fang_tc_on_macos_after_the_bundled_cjk_monos_and_before_generic_monospace()
 {
    for stack in [terminal_font_fallback(true), code_font_fallback(true)] {
        assert!(
            stack.ends_with("\"Noto Sans Mono CJK TC\", \"PingFang TC\", monospace"),
            "{stack}"
        );
    }
}

#[test]
fn leaves_ping_fang_tc_out_on_linux() {
    for stack in [terminal_font_fallback(false), code_font_fallback(false)] {
        assert!(!stack.contains("PingFang"), "{stack}");
        assert!(
            stack.ends_with("\"Noto Sans Mono CJK TC\", monospace"),
            "{stack}"
        );
    }
}

#[test]
fn builds_the_fallbacks_and_stacks_the_ts_app_builds() {
    let table = fixture();
    assert_eq!(UI_FONT_FALLBACK, table["uiFallback"].as_str().unwrap());
    assert_eq!(
        code_font_fallback(true),
        table["codeFallback"]["mac"].as_str().unwrap()
    );
    assert_eq!(
        code_font_fallback(false),
        table["codeFallback"]["other"].as_str().unwrap()
    );
    assert_eq!(
        terminal_font_fallback(true),
        table["terminalFallback"]["mac"].as_str().unwrap()
    );
    assert_eq!(
        terminal_font_fallback(false),
        table["terminalFallback"]["other"].as_str().unwrap()
    );
    let stacks = table["stacks"].as_array().unwrap();
    assert!(stacks.len() >= 10);
    for row in stacks {
        let family = row["family"].as_str().unwrap();
        assert_eq!(ui_font_stack(family), row["ui"].as_str().unwrap(), "{row}");
        assert_eq!(
            code_font_stack(family, Platform::Linux),
            row["code"].as_str().unwrap(),
            "{row}"
        );
        assert_eq!(
            terminal_font_stack(family, Platform::Linux),
            row["terminal"].as_str().unwrap(),
            "{row}"
        );
    }
}

#[test]
fn builds_the_font_tokens_the_ts_app_builds() {
    let table = fixture();
    let rows = table["variables"].as_array().unwrap();
    assert!(rows.len() >= 3);
    for row in rows {
        let surface_of = |key: &str| {
            let font = &row["fonts"][key];
            surface(
                font["family"].as_str().unwrap(),
                font["size"].as_f64().unwrap(),
                u32::try_from(font["weight"].as_u64().unwrap()).unwrap(),
            )
        };
        let settings = UiFontSettings {
            ui: surface_of("ui"),
            editor: surface_of("editor"),
        };
        let actual = ui_font_variables(&settings, Platform::Linux);
        let expected = row["variables"].as_object().unwrap();
        let actual_pairs: Vec<(&str, &str)> = actual
            .iter()
            .map(|(name, value)| (*name, value.as_str()))
            .collect();
        let expected_pairs: Vec<(&str, &str)> = expected
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str().unwrap()))
            .collect();
        assert_eq!(actual_pairs, expected_pairs, "{row}");
    }
}

#[test]
fn puts_the_macos_cjk_font_in_the_code_and_terminal_stacks_only_on_darwin() {
    for family in ["Fira Code", ""] {
        assert!(code_font_stack(family, Platform::Darwin).contains("PingFang TC\", monospace"));
        assert!(terminal_font_stack(family, Platform::Darwin).contains("PingFang TC\", monospace"));
        assert!(!code_font_stack(family, Platform::Linux).contains("PingFang"));
        assert!(!terminal_font_stack(family, Platform::Linux).contains("PingFang"));
    }
    let darwin = ui_font_variables(&fonts(), Platform::Darwin);
    let linux = ui_font_variables(&fonts(), Platform::Linux);
    assert!(darwin["--font-code"].ends_with("\"PingFang TC\", monospace"));
    assert!(!linux["--font-code"].contains("PingFang TC\", monospace"));
    assert_eq!(darwin["--font-ui"], linux["--font-ui"]);
}
