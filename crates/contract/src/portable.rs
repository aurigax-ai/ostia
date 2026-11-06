use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::html_preview::PreviewTheme;

pub const PORTABLE_FORMAT: &str = "ostia-artifact/1";
const PORTABLE_MANIFEST_ID: &str = "ostia-artifact";

pub const PORTABLE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableLimits {
    pub source_file_bytes: u64,
    pub source_bytes: u64,
    pub seed_file_bytes: u64,
    pub file_bytes: u64,
    pub build_ms: u64,
}

pub const PORTABLE_LIMITS: PortableLimits = PortableLimits {
    source_file_bytes: 1024 * 1024,
    source_bytes: 4 * 1024 * 1024,
    seed_file_bytes: 8 * 1024 * 1024,
    file_bytes: 16 * 1024 * 1024,
    build_ms: 10_000,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortableType {
    Component,
    Page,
    Markdown,
    Svg,
    Json,
    Tables,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortableMode {
    Development,
    Production,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortableAction {
    Open,
    Save,
    Copy,
    Publish,
}

fn type_by_extension(extension: &str) -> Option<PortableType> {
    match extension {
        "jsx" | "tsx" => Some(PortableType::Component),
        "html" | "htm" => Some(PortableType::Page),
        "md" | "markdown" => Some(PortableType::Markdown),
        "svg" => Some(PortableType::Svg),
        "json" => Some(PortableType::Json),
        _ => None,
    }
}

pub fn portable_type(path: Option<&str>) -> Option<PortableType> {
    let path = path.unwrap_or_default();
    let (_, extension) = path.rsplit_once('.')?;
    if extension.is_empty() || extension.contains(['/', '\\']) {
        return None;
    }
    type_by_extension(&extension.to_lowercase())
}

pub fn runs_scripts(kind: PortableType) -> bool {
    matches!(kind, PortableType::Component | PortableType::Page)
}

pub fn portable_sandbox(kind: PortableType) -> &'static str {
    if runs_scripts(kind) {
        "allow-scripts"
    } else {
        "allow-popups allow-popups-to-escape-sandbox"
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PortableManifest {
    pub format: String,
    #[serde(rename = "type")]
    pub kind: PortableType,
    pub name: String,
    pub built: String,
    pub ostia: String,
    pub libraries: Vec<String>,
    pub theme: PreviewTheme,
    pub hash: String,
    pub sources: IndexMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableDocument {
    pub body: String,
    pub css: String,
}

fn escape_attribute(text: &str) -> String {
    text.replace('&', "&amp;").replace('"', "&quot;")
}

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn manifest_json(manifest: &PortableManifest) -> String {
    serde_json::to_string(manifest)
        .unwrap_or_default()
        .replace('<', "\\u003c")
}

const OUTER_STYLE: &str =
    "html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}";

pub fn wrap_portable(document: &str, manifest: &PortableManifest) -> String {
    let title = escape_text(&manifest.name);
    [
        "<!doctype html>".to_owned(),
        "<html>".to_owned(),
        "<head>".to_owned(),
        "<meta charset=\"utf-8\">".to_owned(),
        format!(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">",
            escape_attribute(PORTABLE_CSP)
        ),
        "<meta name=\"referrer\" content=\"no-referrer\">".to_owned(),
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">".to_owned(),
        format!("<title>{title}</title>"),
        format!("<style>{OUTER_STYLE}</style>"),
        format!(
            "<script type=\"application/json\" id=\"{PORTABLE_MANIFEST_ID}\">{}</script>",
            manifest_json(manifest)
        ),
        "</head>".to_owned(),
        "<body>".to_owned(),
        format!(
            "<iframe sandbox=\"{}\" allow=\"clipboard-write\" title=\"{}\" srcdoc=\"{}\"></iframe>",
            portable_sandbox(manifest.kind),
            title.replace('"', "&quot;"),
            escape_attribute(document)
        ),
        "</body>".to_owned(),
        "</html>".to_owned(),
        String::new(),
    ]
    .join("\n")
}

fn theme_rule(theme: &PreviewTheme) -> String {
    let vars = theme
        .vars
        .iter()
        .map(|(name, value)| format!("{name}:{value}"))
        .collect::<Vec<_>>()
        .join(";");
    let scheme = if theme.dark { "dark" } else { "light" };
    format!(":root{{color-scheme:{scheme};{vars}}}")
}

const CLOSING_STYLE: &str = "</style";

fn escape_closing_style(css: &str) -> String {
    let lower = css.to_ascii_lowercase();
    let mut out = String::with_capacity(css.len());
    let mut from = 0;
    while let Some(found) = lower[from..].find(CLOSING_STYLE) {
        let start = from + found;
        out.push_str(&css[from..start]);
        out.push_str("<\\/style");
        from = start + CLOSING_STYLE.len();
    }
    out.push_str(&css[from..]);
    out
}

pub fn document_page(title: &str, body: &str, css: &str, theme: &PreviewTheme) -> String {
    let html_open = if theme.dark {
        "<html class=\"dark\">"
    } else {
        "<html>"
    };
    let css_block = if css.is_empty() {
        String::new()
    } else {
        format!("<style>{}</style>", escape_closing_style(css))
    };
    [
        "<!doctype html>".to_owned(),
        html_open.to_owned(),
        "<head>".to_owned(),
        "<meta charset=\"utf-8\">".to_owned(),
        format!("<title>{}</title>", escape_text(title)),
        format!(
            "<style>{}body{{margin:0;background:var(--ostia-bg,Canvas);color:var(--ostia-fg,CanvasText);font-family:var(--ostia-font,system-ui,sans-serif)}}</style>",
            theme_rule(theme)
        ),
        css_block,
        "</head>".to_owned(),
        format!("<body>{body}</body>"),
        "</html>".to_owned(),
        String::new(),
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

pub fn portable_file_name(path: &str) -> String {
    let base = path.rsplit(['\\', '/']).next().unwrap_or("artifact");
    let stem = match base.rfind('.') {
        Some(index) if index + 1 < base.len() => &base[..index],
        _ => base,
    };
    let stem = if stem.is_empty() { "artifact" } else { stem };
    format!("{stem}.html")
}
