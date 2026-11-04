use ostia_base::js::js_round;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::theme::theme_choice::{MATCH_OSTIA_THEME, parse_theme_choice};

pub const SEARCH_ENGINES: [&str; 5] = ["google", "duckduckgo", "bing", "kagi", "custom"];

const GOOGLE_TEMPLATE: &str = "https://www.google.com/search?q={query}";
const QUERY_PLACEHOLDER: &str = "{query}";

const URI_COMPONENT: AsciiSet = NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub const ZOOM_MIN: u32 = 50;
pub const ZOOM_MAX: u32 = 300;
const DEFAULT_ZOOM: u32 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchEngine {
    Google,
    Duckduckgo,
    Bing,
    Kagi,
    Custom,
}

impl SearchEngine {
    const ALL: [Self; 5] = [
        Self::Google,
        Self::Duckduckgo,
        Self::Bing,
        Self::Kagi,
        Self::Custom,
    ];

    fn template(self) -> Option<&'static str> {
        match self {
            Self::Google => Some(GOOGLE_TEMPLATE),
            Self::Duckduckgo => Some("https://duckduckgo.com/?q={query}"),
            Self::Bing => Some("https://www.bing.com/search?q={query}"),
            Self::Kagi => Some("https://kagi.com/search?q={query}"),
            Self::Custom => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSettings {
    pub search_engine: SearchEngine,
    pub custom_search_url: String,
    pub default_zoom: u32,
    pub attach_capture_image: bool,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            search_engine: SearchEngine::Google,
            custom_search_url: String::new(),
            default_zoom: DEFAULT_ZOOM,
            attach_capture_image: true,
        }
    }
}

pub fn is_valid_search_template(template: &str) -> bool {
    if !template.contains(QUERY_PLACEHOLDER) {
        return false;
    }
    Url::parse(&template.replace(QUERY_PLACEHOLDER, "q"))
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

pub fn clamp_zoom(percent: f64) -> u32 {
    if !percent.is_finite() {
        return DEFAULT_ZOOM;
    }
    let rounded = js_round(percent).clamp(f64::from(ZOOM_MIN), f64::from(ZOOM_MAX));
    rounded as u32
}

pub fn search_url(settings: &BrowserSettings, query: &str) -> String {
    let template = settings.search_engine.template().unwrap_or_else(|| {
        if is_valid_search_template(&settings.custom_search_url) {
            &settings.custom_search_url
        } else {
            GOOGLE_TEMPLATE
        }
    });
    template.replace(
        QUERY_PLACEHOLDER,
        &utf8_percent_encode(query, &URI_COMPONENT).to_string(),
    )
}

fn pick<T: Copy>(names: &[&str], variants: &[T], value: Option<&Value>, fallback: T) -> T {
    value
        .and_then(Value::as_str)
        .and_then(|text| names.iter().position(|name| *name == text))
        .and_then(|index| variants.get(index).copied())
        .unwrap_or(fallback)
}

fn flag(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

pub fn parse_browser_settings(raw: &Value) -> BrowserSettings {
    let defaults = BrowserSettings::default();
    let Some(src) = raw.as_object() else {
        return defaults;
    };
    BrowserSettings {
        search_engine: pick(
            &SEARCH_ENGINES,
            &SearchEngine::ALL,
            src.get("searchEngine"),
            defaults.search_engine,
        ),
        custom_search_url: src
            .get("customSearchUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        default_zoom: src
            .get("defaultZoom")
            .and_then(Value::as_f64)
            .map_or(defaults.default_zoom, clamp_zoom),
        attach_capture_image: flag(src.get("attachCaptureImage"), defaults.attach_capture_image),
    }
}

const WORD_WRAPS: [&str; 2] = ["off", "on"];
const LINE_NUMBER_MODES: [&str; 3] = ["on", "off", "relative"];
pub const TAB_WIDTHS: [u32; 3] = [2, 4, 8];
const AUTO_SAVE_MODES: [&str; 3] = ["off", "afterDelay", "onFocusChange"];
pub const OPEN_FILES_IN: [&str; 2] = ["tab", "split"];
pub const DIFF_LAYOUTS: [&str; 3] = ["auto", "sideBySide", "inline"];

pub const AUTO_SAVE_DELAY_MS: u64 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WordWrap {
    Off,
    On,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineNumberMode {
    On,
    Off,
    Relative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoSaveMode {
    Off,
    AfterDelay,
    OnFocusChange,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenFilesIn {
    Tab,
    Split,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLayout {
    Auto,
    SideBySide,
    Inline,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    pub word_wrap: WordWrap,
    pub line_numbers: LineNumberMode,
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub auto_save: AutoSaveMode,
    pub format_on_save: bool,
    pub open_files_in: OpenFilesIn,
    pub theme: String,
    pub diff_layout: DiffLayout,
    pub diff_ignore_whitespace: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            word_wrap: WordWrap::Off,
            line_numbers: LineNumberMode::On,
            tab_size: TAB_WIDTHS[0],
            insert_spaces: true,
            auto_save: AutoSaveMode::Off,
            format_on_save: false,
            open_files_in: OpenFilesIn::Tab,
            theme: MATCH_OSTIA_THEME.to_owned(),
            diff_layout: DiffLayout::Auto,
            diff_ignore_whitespace: false,
        }
    }
}

fn tab_width(value: Option<&Value>, fallback: u32) -> u32 {
    value
        .and_then(Value::as_f64)
        .and_then(|number| {
            TAB_WIDTHS
                .iter()
                .copied()
                .find(|width| f64::from(*width) == number)
        })
        .unwrap_or(fallback)
}

pub fn parse_editor_settings(raw: &Value) -> EditorSettings {
    let defaults = EditorSettings::default();
    let Some(src) = raw.as_object() else {
        return defaults;
    };
    EditorSettings {
        word_wrap: pick(
            &WORD_WRAPS,
            &[WordWrap::Off, WordWrap::On],
            src.get("wordWrap"),
            defaults.word_wrap,
        ),
        line_numbers: pick(
            &LINE_NUMBER_MODES,
            &[
                LineNumberMode::On,
                LineNumberMode::Off,
                LineNumberMode::Relative,
            ],
            src.get("lineNumbers"),
            defaults.line_numbers,
        ),
        tab_size: tab_width(src.get("tabSize"), defaults.tab_size),
        insert_spaces: flag(src.get("insertSpaces"), true),
        auto_save: pick(
            &AUTO_SAVE_MODES,
            &[
                AutoSaveMode::Off,
                AutoSaveMode::AfterDelay,
                AutoSaveMode::OnFocusChange,
            ],
            src.get("autoSave"),
            defaults.auto_save,
        ),
        format_on_save: flag(src.get("formatOnSave"), false),
        open_files_in: pick(
            &OPEN_FILES_IN,
            &[OpenFilesIn::Tab, OpenFilesIn::Split],
            src.get("openFilesIn"),
            defaults.open_files_in,
        ),
        theme: parse_theme_choice(src.get("theme").unwrap_or(&Value::Null)),
        diff_layout: pick(
            &DIFF_LAYOUTS,
            &[DiffLayout::Auto, DiffLayout::SideBySide, DiffLayout::Inline],
            src.get("diffLayout"),
            defaults.diff_layout,
        ),
        diff_ignore_whitespace: src.get("diffIgnoreWhitespace") == Some(&Value::Bool(true)),
    }
}
