use indexmap::IndexMap;
use ostia_base::Platform;
use ostia_base::js::{js_number_text, js_trim};

pub const UI_FONT_FALLBACK: &str = "\"Inter Variable\", system-ui, -apple-system, \"Segoe UI\", Roboto, \"PingFang TC\", \"Microsoft JhengHei\", \"Hiragino Sans\", \"Noto Sans CJK TC\", \"Noto Sans TC\", sans-serif";

const LATIN_MONO_FALLBACK: &str = "\"DejaVu Sans Mono\", SFMono-Regular, Menlo, Consolas";

const UNSAFE_IN_FAMILY: [char; 7] = ['"', '\\', ';', '{', '}', '<', '>'];

#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceFont {
    pub family: String,
    pub size: f64,
    pub weight: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UiFontSettings {
    pub ui: SurfaceFont,
    pub editor: SurfaceFont,
}

fn cjk_mono_fallback(mac: bool) -> String {
    let pingfang = if mac { "\"PingFang TC\", " } else { "" };
    format!("\"Sarasa Mono TC\", \"Noto Sans Mono CJK TC\", {pingfang}monospace")
}

pub fn code_font_fallback(mac: bool) -> String {
    format!(
        "\"Geist Mono Variable\", \"Hack Nerd Font Mono\", {LATIN_MONO_FALLBACK}, {}",
        cjk_mono_fallback(mac)
    )
}

pub fn terminal_font_fallback(mac: bool) -> String {
    format!(
        "\"Hack Nerd Font Mono\", {LATIN_MONO_FALLBACK}, {}",
        cjk_mono_fallback(mac)
    )
}

pub fn font_stack(family: &str, fallback: &str) -> String {
    let cleaned: String = family
        .chars()
        .filter(|ch| !UNSAFE_IN_FAMILY.contains(ch))
        .collect();
    let name = js_trim(&cleaned);
    if name.is_empty() {
        fallback.to_owned()
    } else {
        format!("\"{name}\", {fallback}")
    }
}

pub fn terminal_font_stack(family: &str, platform: Platform) -> String {
    font_stack(
        family,
        &terminal_font_fallback(platform == Platform::Darwin),
    )
}

pub fn code_font_stack(family: &str, platform: Platform) -> String {
    font_stack(family, &code_font_fallback(platform == Platform::Darwin))
}

pub fn ui_font_stack(family: &str) -> String {
    font_stack(family, UI_FONT_FALLBACK)
}

pub fn ui_font_variables(
    settings: &UiFontSettings,
    platform: Platform,
) -> IndexMap<&'static str, String> {
    IndexMap::from([
        ("--font-ui", ui_font_stack(&settings.ui.family)),
        (
            "--font-code",
            code_font_stack(&settings.editor.family, platform),
        ),
        (
            "--font-ui-size",
            format!("{}px", js_number_text(settings.ui.size)),
        ),
        ("--font-ui-weight", settings.ui.weight.to_string()),
    ])
}
