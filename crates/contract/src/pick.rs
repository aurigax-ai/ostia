use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use ostia_base::js::{
    JS_SPACE_CLASS, is_js_space, js_number_text, js_trim, non_empty, serialize_js_number,
    static_regex, utf16_len,
};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use url::Url;

pub const PICK_HTML_MAX: usize = 2048;
pub const PICK_TEXT_MAX: usize = 300;
pub const PICK_URL_MAX: usize = 500;
pub const PICK_NOTE_MAX: usize = 4000;
pub const PICK_LOG_MAX: usize = 20;
pub const PICK_TABLE_CELLS_MAX: usize = 10_000;
pub const PICK_TABLE_CSV_MAX: usize = 256 * 1024;
const PICK_CELL_MAX: usize = 2000;
const PICK_STYLE_VALUE_MAX: usize = 200;
const PICK_ROLE_MAX: usize = 60;
const PICK_LOG_LEVEL_MAX: usize = 20;
const PICK_LOG_METHOD_MAX: usize = 16;

pub const SCREENSHOT_MARGIN: f64 = 16.0;
pub const REPORT_SLUG_MAX: usize = 48;

const PICK_STYLE_PROPS: [&str; 18] = [
    "display",
    "position",
    "box-sizing",
    "width",
    "height",
    "margin",
    "padding",
    "border",
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "opacity",
    "visibility",
    "overflow",
    "z-index",
];

static JSON_NULL: Value = Value::Null;
static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| static_regex(&format!("[{JS_SPACE_CLASS}]+")));
static NON_SLUG_RUN: LazyLock<Regex> = LazyLock::new(|| static_regex("[^a-z0-9]+"));
static CAPTURE_REPORT_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^capture-([0-9]+)(?:-[a-z0-9-]*)?\.(?:md|png)$"));

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PickBox {
    #[serde(serialize_with = "serialize_js_number")]
    pub x: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub y: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub width: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PickViewport {
    #[serde(serialize_with = "serialize_js_number")]
    pub width: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickLogEntry {
    pub level: String,
    pub text: String,
    pub ts: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFailedRequest {
    pub url: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub ts: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PickTable {
    pub rows: usize,
    pub columns: usize,
    pub truncated: bool,
    pub csv: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickCapture {
    pub id: String,
    pub url: String,
    pub title: String,
    pub selector: String,
    pub label: String,
    pub html: String,
    pub html_truncated: bool,
    #[serde(rename = "box")]
    pub box_: PickBox,
    pub viewport: PickViewport,
    pub has_text: bool,
    pub table: Option<PickTable>,
    #[serde(serialize_with = "serialize_styles")]
    pub styles: Vec<(String, String)>,
    pub role: String,
    pub name: String,
    pub console_errors: Vec<PickLogEntry>,
    pub failed_requests: Vec<PickFailedRequest>,
    pub screenshot_path: Option<String>,
    pub captured_at: String,
}

pub struct CaptureExtras {
    pub id: String,
    pub console_errors: Vec<PickLogEntry>,
    pub failed_requests: Vec<PickFailedRequest>,
    pub screenshot_path: Option<String>,
    pub captured_at: DateTime<Utc>,
}

fn field<'a>(raw: &'a Value, key: &str) -> &'a Value {
    raw.get(key).unwrap_or(&JSON_NULL)
}

fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, ch) in text.char_indices() {
        used += ch.len_utf16();
        if used > units {
            return &text[..index];
        }
    }
    text
}

fn js_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_text(number.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_text(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn clip_str(text: &str, max: usize) -> String {
    if utf16_len(text) > max {
        format!("{}…", utf16_prefix(text, max.saturating_sub(1)))
    } else {
        text.to_owned()
    }
}

pub fn clip(text: &Value, max: usize) -> String {
    clip_str(&js_text(text), max)
}

fn finite(value: &Value) -> f64 {
    let Some(number) = value.as_f64() else {
        return 0.0;
    };
    let scaled = number * 100.0;
    let floor = scaled.floor();
    let rounded = if scaled - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    rounded / 100.0 + 0.0
}

pub fn normalize_box(raw: &Value) -> PickBox {
    PickBox {
        x: finite(field(raw, "x")),
        y: finite(field(raw, "y")),
        width: finite(field(raw, "width")),
        height: finite(field(raw, "height")),
    }
}

fn normalize_viewport(raw: &Value) -> PickViewport {
    PickViewport {
        width: finite(field(raw, "width")),
        height: finite(field(raw, "height")),
    }
}

fn csv_field(cell: &str) -> String {
    if cell.chars().any(|ch| matches!(ch, '"' | ',' | '\r' | '\n')) {
        format!("\"{}\"", cell.replace('"', "\"\""))
    } else {
        cell.to_owned()
    }
}

fn clean_rows(raw: &Value) -> Option<Vec<Vec<String>>> {
    let Value::Array(rows) = raw else {
        return None;
    };
    let mut cleaned = Vec::with_capacity(rows.len());
    for row in rows {
        let Value::Array(cells) = row else {
            return None;
        };
        cleaned.push(
            cells
                .iter()
                .map(|cell| clip_str(cell.as_str().unwrap_or(""), PICK_CELL_MAX))
                .collect(),
        );
    }
    (!cleaned.is_empty()).then_some(cleaned)
}

pub fn normalize_table(raw: &Value) -> Option<PickTable> {
    let cleaned = clean_rows(raw)?;
    let columns = cleaned.iter().map(Vec::len).max()?;
    if columns == 0 {
        return None;
    }
    let fitting = (PICK_TABLE_CELLS_MAX / columns).max(1);
    let mut lines: Vec<String> = Vec::new();
    let mut bytes = 0;
    for row in cleaned.iter().take(fitting) {
        let line = (0..columns)
            .map(|index| csv_field(row.get(index).map_or("", String::as_str)))
            .collect::<Vec<_>>()
            .join(",");
        let size = line.len() + 1;
        if !lines.is_empty() && bytes + size > PICK_TABLE_CSV_MAX {
            break;
        }
        lines.push(if size > PICK_TABLE_CSV_MAX {
            utf16_prefix(&line, PICK_TABLE_CSV_MAX / 4).to_owned()
        } else {
            line
        });
        bytes += size;
    }
    Some(PickTable {
        rows: lines.len(),
        columns,
        truncated: lines.len() < cleaned.len(),
        csv: lines.join("\n"),
    })
}

fn serialize_styles<S: serde::Serializer>(
    styles: &[(String, String)],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(styles.iter().map(|(key, value)| (key, value)))
}

fn normalize_styles(styles: &Value) -> Vec<(String, String)> {
    let Value::Object(map) = styles else {
        return Vec::new();
    };
    PICK_STYLE_PROPS
        .iter()
        .filter_map(|prop| match map.get(*prop) {
            Some(Value::String(value)) if !value.is_empty() => {
                Some(((*prop).to_owned(), clip_str(value, PICK_STYLE_VALUE_MAX)))
            }
            _ => None,
        })
        .collect()
}

fn iso_millis(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn iso(ts: i64) -> String {
    DateTime::from_timestamp_millis(ts).map_or_else(String::new, iso_millis)
}

pub fn normalize_capture(raw: &Value, extras: CaptureExtras) -> PickCapture {
    let html_source = field(raw, "html").as_str().unwrap_or("");
    let html_truncated = utf16_len(html_source) > PICK_HTML_MAX;
    let html = if html_truncated {
        utf16_prefix(html_source, PICK_HTML_MAX)
    } else {
        html_source
    };
    let log_skip = extras.console_errors.len().saturating_sub(PICK_LOG_MAX);
    let request_skip = extras.failed_requests.len().saturating_sub(PICK_LOG_MAX);
    PickCapture {
        id: extras.id,
        url: clip(field(raw, "url"), PICK_URL_MAX),
        title: clip(field(raw, "title"), PICK_TEXT_MAX),
        selector: clip(field(raw, "selector"), PICK_TEXT_MAX * 4),
        label: clip(field(raw, "label"), PICK_TEXT_MAX),
        html: html.to_owned(),
        html_truncated,
        box_: normalize_box(field(raw, "box")),
        viewport: normalize_viewport(field(raw, "viewport")),
        has_text: matches!(field(raw, "hasText"), Value::Bool(true)),
        table: normalize_table(field(raw, "table")),
        styles: normalize_styles(field(raw, "styles")),
        role: clip(field(raw, "role"), PICK_ROLE_MAX),
        name: clip(field(raw, "name"), PICK_TEXT_MAX),
        console_errors: extras
            .console_errors
            .iter()
            .skip(log_skip)
            .map(|entry| PickLogEntry {
                level: clip_str(&entry.level, PICK_LOG_LEVEL_MAX),
                text: clip_str(&entry.text, PICK_TEXT_MAX * 2),
                ts: entry.ts,
            })
            .collect(),
        failed_requests: extras
            .failed_requests
            .iter()
            .skip(request_skip)
            .map(|request| PickFailedRequest {
                url: clip_str(&request.url, PICK_URL_MAX),
                method: clip_str(&request.method, PICK_LOG_METHOD_MAX),
                status: request.status,
                error: request
                    .error
                    .as_deref()
                    .map(|error| clip_str(error, PICK_TEXT_MAX)),
                ts: request.ts,
            })
            .collect(),
        screenshot_path: extras.screenshot_path,
        captured_at: iso_millis(extras.captured_at),
    }
}

pub fn screenshot_rect(box_: &PickBox, viewport: &PickViewport, zoom: f64) -> Option<PickBox> {
    let visible_left = box_.x.max(0.0);
    let visible_top = box_.y.max(0.0);
    let visible_right = viewport.width.min(box_.x + box_.width);
    let visible_bottom = viewport.height.min(box_.y + box_.height);
    if visible_right - visible_left < 1.0 || visible_bottom - visible_top < 1.0 {
        return None;
    }
    let left = (box_.x - SCREENSHOT_MARGIN).max(0.0);
    let top = (box_.y - SCREENSHOT_MARGIN).max(0.0);
    let right = viewport.width.min(box_.x + box_.width + SCREENSHOT_MARGIN);
    let bottom = viewport
        .height
        .min(box_.y + box_.height + SCREENSHOT_MARGIN);
    let scale = if zoom > 0.0 { zoom } else { 1.0 };
    Some(PickBox {
        x: (left * scale).floor(),
        y: (top * scale).floor(),
        width: ((right - left) * scale).ceil(),
        height: ((bottom - top) * scale).ceil(),
    })
}

pub fn fence(text: &str, lang: &str) -> String {
    let mut ticks = "```".to_owned();
    while text.contains(ticks.as_str()) {
        ticks.push('`');
    }
    format!("{ticks}{lang}\n{text}\n{ticks}")
}

fn inline_code(text: &str) -> String {
    let flat = SPACE_RUN.replace_all(text, " ");
    if flat.contains('`') {
        format!("`` {flat} ``")
    } else {
        format!("`{flat}`")
    }
}

pub fn markdown_image(alt: &str, path: &str) -> String {
    let target = if path
        .chars()
        .any(|ch| is_js_space(ch) || matches!(ch, '(' | ')' | '<' | '>'))
    {
        format!("<{}>", path.replace('<', "%3C").replace('>', "%3E"))
    } else {
        path.to_owned()
    };
    let alt: String = alt
        .chars()
        .filter(|ch| !matches!(ch, '[' | ']' | '\\'))
        .collect();
    format!("![{alt}]({target})")
}

pub fn render_pick_report(capture: &PickCapture, note: &str, for_copy: bool) -> String {
    let mut lines: Vec<String> = Vec::new();
    let trimmed_note = clip_str(js_trim(note), PICK_NOTE_MAX);
    let screenshot = non_empty(capture.screenshot_path.as_deref());

    lines.push(format!(
        "# Captured element: {}",
        non_empty(Some(capture.label.as_str())).unwrap_or(&capture.selector)
    ));
    lines.push(String::new());
    if !for_copy {
        lines.push("## Note".to_owned());
        lines.push(String::new());
        lines.push(
            non_empty(Some(trimmed_note.as_str()))
                .unwrap_or("(no note)")
                .to_owned(),
        );
        lines.push(String::new());
    }

    lines.push("## Element".to_owned());
    lines.push(String::new());
    let page_title = non_empty(Some(capture.title.as_str()))
        .map_or_else(String::new, |title| format!("{title} — "));
    lines.push(format!("- Page: {page_title}{}", capture.url));
    lines.push(format!("- Selector: {}", inline_code(&capture.selector)));
    lines.push(format!(
        "- Role / name: {} / {}",
        non_empty(Some(capture.role.as_str())).unwrap_or("-"),
        non_empty(Some(capture.name.as_str())).unwrap_or("-"),
    ));
    let b = capture.box_;
    lines.push(format!(
        "- Box: x {}, y {}, {} × {} (CSS px, viewport)",
        b.x, b.y, b.width, b.height
    ));
    if let Some(table) = &capture.table {
        lines.push(format!(
            "- Table: {} rows × {} columns{}",
            table.rows,
            table.columns,
            if table.truncated { " (truncated)" } else { "" }
        ));
    }
    if !for_copy {
        lines.push(match screenshot {
            Some(path) => format!(
                "- Screenshot: {path} (the element and up to {SCREENSHOT_MARGIN} CSS px around it)"
            ),
            None => "- Screenshot: (not captured: element off screen)".to_owned(),
        });
    }
    lines.push(format!("- Captured: {}", capture.captured_at));
    lines.push(String::new());
    if let Some(path) = screenshot.filter(|_| !for_copy) {
        lines.push("## Screenshot".to_owned());
        lines.push(String::new());
        lines.push(markdown_image("Captured element", path));
        lines.push(String::new());
    }

    if !capture.styles.is_empty() {
        lines.push("## Computed style".to_owned());
        lines.push(String::new());
        lines.extend(
            capture
                .styles
                .iter()
                .map(|(key, value)| format!("- {key}: {value}")),
        );
        lines.push(String::new());
    }

    match &capture.table {
        Some(table) => {
            lines.push("## Table (CSV)".to_owned());
            lines.push(String::new());
            lines.push(fence(&table.csv, "csv"));
            lines.push(String::new());
        }
        None => {
            lines.push(format!(
                "## HTML{}",
                if capture.html_truncated {
                    " (truncated)"
                } else {
                    ""
                }
            ));
            lines.push(String::new());
            lines.push(fence(&capture.html, "html"));
            lines.push(String::new());
        }
    }

    lines.push("## Console errors".to_owned());
    lines.push(String::new());
    if capture.console_errors.is_empty() {
        lines.push("None recorded.".to_owned());
    } else {
        lines.extend(
            capture
                .console_errors
                .iter()
                .map(|entry| format!("- {} {}", iso(entry.ts), inline_code(&entry.text))),
        );
    }

    lines.push(String::new());
    lines.push("## Failed network requests".to_owned());
    lines.push(String::new());
    if capture.failed_requests.is_empty() {
        lines.push("None recorded.".to_owned());
    } else {
        lines.extend(capture.failed_requests.iter().map(|request| {
            let why = match request.status {
                Some(status) => format!("HTTP {status}"),
                None => request.error.clone().unwrap_or_else(|| "failed".to_owned()),
            };
            format!(
                "- {} {} {} → {why}",
                iso(request.ts),
                request.method,
                inline_code(&request.url)
            )
        }));
    }
    lines.push(String::new());
    lines.join("\n")
}

pub fn pick_bus_message(capture: &PickCapture, note: &str, report: &str) -> String {
    json!({
        "kind": "capture",
        "report": report,
        "image": capture.screenshot_path,
        "url": capture.url,
        "selector": capture.selector,
        "note": clip_str(js_trim(note), PICK_NOTE_MAX),
    })
    .to_string()
}

pub fn report_reference(path: &str) -> String {
    if path.chars().any(is_js_space) {
        format!("@\"{path}\" ")
    } else {
        format!("@{path} ")
    }
}

pub fn capture_references(report: &str, image: Option<&str>) -> String {
    match non_empty(image) {
        Some(image) => format!("{}{}", report_reference(report), report_reference(image)),
        None => report_reference(report),
    }
}

pub fn url_slug(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        return String::new();
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return String::new();
    }
    let host = parsed.host_str().unwrap_or_default();
    let authority = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    let lowered = format!("{authority}{}", parsed.path()).to_lowercase();
    let without_www = lowered.strip_prefix("www.").unwrap_or(lowered.as_str());
    let slug = NON_SLUG_RUN.replace_all(without_www, "-").into_owned();
    let clipped = &slug[..slug.len().min(REPORT_SLUG_MAX)];
    clipped.trim_matches('-').to_owned()
}

pub fn capture_stem(n: u64, url: &str) -> String {
    let slug = url_slug(url);
    if slug.is_empty() {
        format!("capture-{n}")
    } else {
        format!("capture-{n}-{slug}")
    }
}

pub fn next_pick_report_number(names: &[&str]) -> u64 {
    names
        .iter()
        .filter_map(|name| CAPTURE_REPORT_NAME.captures(name))
        .map(|captures| captures[1].parse::<u64>().unwrap_or(u64::MAX))
        .fold(0, u64::max)
        .saturating_add(1)
}
