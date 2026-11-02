use std::sync::LazyLock;

use ostia_base::js::{is_js_space, static_regex, utf16_len};
use regex::{Captures, Regex};
use serde_json::Value;

pub const DEFAULT_WINDOW_TITLE: &str = "{workspace} · {product}";
pub const WINDOW_TITLE_MAX: usize = 120;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowTitleValues {
    pub product: String,
    pub workspace: Option<String>,
    pub pane: Option<String>,
    pub cwd: Option<String>,
}

static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"\{(product|workspace|pane|cwd)\}"));

fn is_edge_separator(ch: char) -> bool {
    is_js_space(ch) || matches!(ch, '·' | '—' | '–' | '-' | '|' | ':')
}

pub fn parse_window_title(raw: &Value) -> String {
    match raw.as_str() {
        Some(text) if utf16_len(text) <= WINDOW_TITLE_MAX => text.to_owned(),
        _ => DEFAULT_WINDOW_TITLE.to_owned(),
    }
}

pub fn format_window_title(template: &str, values: &WindowTitleValues) -> String {
    let filled = PLACEHOLDER.replace_all(template, |caps: &Captures| match &caps[1] {
        "product" => values.product.clone(),
        "workspace" => values.workspace.clone().unwrap_or_default(),
        "pane" => values.pane.clone().unwrap_or_default(),
        _ => values.cwd.clone().unwrap_or_default(),
    });
    let trimmed = filled.trim_matches(is_edge_separator);
    if trimmed.is_empty() {
        values.product.clone()
    } else {
        trimmed.to_owned()
    }
}
