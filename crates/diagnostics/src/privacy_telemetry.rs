use std::sync::{Arc, LazyLock};

use ostia_base::clock::Clock;
use ostia_base::js::{JS_DOT, JS_SPACE_CLASS, static_regex};
use regex::{Captures, Regex};
use serde::Serialize;
use serde_json::{Map, Number, Value};
use url::Url;

use crate::text_clip::clip_printable;

pub const TELEMETRY_URL_ENV: &str = "TELEMETRY_URL";
pub const TELEMETRY_MESSAGE_MAX: usize = 1000;
pub const TELEMETRY_QUEUE_MAX: usize = 50;
pub const TELEMETRY_SENT_MAX: usize = 20;
pub const TELEMETRY_BATCH_MAX: usize = 20;
pub const TELEMETRY_SEND_ATTEMPTS: usize = 3;
pub const TELEMETRY_COUNTS_MAX: usize = 200;
pub const TELEMETRY_LIST_MAX: usize = 100;
const TELEMETRY_FRAMES_MAX: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetryCategory {
    Errors,
    Usage,
    Features,
    Terminal,
    Extensions,
    Agents,
}

pub const TELEMETRY_CATEGORIES: [TelemetryCategory; 6] = [
    TelemetryCategory::Errors,
    TelemetryCategory::Usage,
    TelemetryCategory::Features,
    TelemetryCategory::Terminal,
    TelemetryCategory::Extensions,
    TelemetryCategory::Agents,
];

pub const USAGE_CATEGORIES: [TelemetryCategory; 5] = [
    TelemetryCategory::Usage,
    TelemetryCategory::Features,
    TelemetryCategory::Terminal,
    TelemetryCategory::Extensions,
    TelemetryCategory::Agents,
];

impl TelemetryCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Errors => "errors",
            Self::Usage => "usage",
            Self::Features => "features",
            Self::Terminal => "terminal",
            Self::Extensions => "extensions",
            Self::Agents => "agents",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        TELEMETRY_CATEGORIES
            .into_iter()
            .find(|category| category.as_str() == text)
    }

    pub fn parse_usage(text: &str) -> Option<Self> {
        Self::parse(text).filter(|category| USAGE_CATEGORIES.contains(category))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageKeyKind {
    Count,
    Ids,
    Value,
    List,
}

pub fn usage_key_kind(category: TelemetryCategory, key: &str) -> Option<UsageKeyKind> {
    use UsageKeyKind::{Count, Ids, List, Value};
    let keys: &[(&str, UsageKeyKind)] = match category {
        TelemetryCategory::Errors => &[],
        TelemetryCategory::Usage => &[
            ("app_starts", Count),
            ("session_minutes", Value),
            ("windows", Value),
            ("workspaces", Value),
            ("restore", Value),
        ],
        TelemetryCategory::Features => &[
            ("command", Ids),
            ("surface", Ids),
            ("settings", Ids),
            ("chord", Ids),
            ("input_mode", Value),
            ("prompt_style", Value),
        ],
        TelemetryCategory::Terminal => &[
            ("engine", Value),
            ("gpu", Value),
            ("webgl_fallback", Count),
            ("wake", Count),
            ("spawn_failure", Ids),
            ("shell", Ids),
        ],
        TelemetryCategory::Extensions => &[
            ("installed", List),
            ("enabled", List),
            ("setting_change", Ids),
        ],
        TelemetryCategory::Agents => &[
            ("session", Ids),
            ("resume", Count),
            ("hibernation", Count),
            ("approval_shown", Ids),
            ("approval_answered", Ids),
            ("question_asked", Count),
            ("question_answered", Count),
            ("bus_message", Count),
        ],
    };
    keys.iter()
        .find(|(known, _)| *known == key)
        .map(|(_, kind)| *kind)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorSource {
    MainException,
    MainRejection,
    RendererGone,
    RendererError,
    RendererRejection,
    RenderError,
    SurfaceError,
    ExtensionCrashed,
}

impl ErrorSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MainException => "main-exception",
            Self::MainRejection => "main-rejection",
            Self::RendererGone => "renderer-gone",
            Self::RendererError => "renderer-error",
            Self::RendererRejection => "renderer-rejection",
            Self::RenderError => "render-error",
            Self::SurfaceError => "surface-error",
            Self::ExtensionCrashed => "extension-crashed",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TelemetrySettings {
    errors: bool,
    usage: bool,
    features: bool,
    terminal: bool,
    extensions: bool,
    agents: bool,
}

impl TelemetrySettings {
    pub fn get(&self, category: TelemetryCategory) -> bool {
        match category {
            TelemetryCategory::Errors => self.errors,
            TelemetryCategory::Usage => self.usage,
            TelemetryCategory::Features => self.features,
            TelemetryCategory::Terminal => self.terminal,
            TelemetryCategory::Extensions => self.extensions,
            TelemetryCategory::Agents => self.agents,
        }
    }

    pub fn set(&mut self, category: TelemetryCategory, on: bool) {
        match category {
            TelemetryCategory::Errors => self.errors = on,
            TelemetryCategory::Usage => self.usage = on,
            TelemetryCategory::Features => self.features = on,
            TelemetryCategory::Terminal => self.terminal = on,
            TelemetryCategory::Extensions => self.extensions = on,
            TelemetryCategory::Agents => self.agents = on,
        }
    }
}

pub fn parse_telemetry_settings(raw: &Value) -> TelemetrySettings {
    let mut settings = TelemetrySettings::default();
    for category in TELEMETRY_CATEGORIES {
        let on = raw
            .get(category.as_str())
            .is_some_and(|value| *value == Value::Bool(true));
        settings.set(category, on);
    }
    settings
}

pub fn any_telemetry_on(settings: &TelemetrySettings) -> bool {
    TELEMETRY_CATEGORIES
        .into_iter()
        .any(|category| settings.get(category))
}

#[derive(Clone, PartialEq, Eq)]
pub struct TelemetryEndpoint {
    pub url: String,
    pub api_key: String,
}

impl std::fmt::Debug for TelemetryEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelemetryEndpoint")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

pub fn parse_ingest(host: &str, api_key: &str) -> Option<TelemetryEndpoint> {
    let url = Url::parse(host).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    let key = if api_key.is_empty() {
        url.username()
    } else {
        api_key
    };
    if key.is_empty()
        || url.query().is_some_and(|query| !query.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
    {
        return None;
    }
    let host_name = url.host_str()?;
    let authority = match url.port() {
        Some(port) => format!("{host_name}:{port}"),
        None => host_name.to_owned(),
    };
    Some(TelemetryEndpoint {
        url: format!("{}://{authority}/batch/", url.scheme()),
        api_key: key.to_owned(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StackFrame {
    pub platform: &'static str,
    pub in_app: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineno: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colno: Option<Number>,
}

#[derive(Debug, Clone)]
pub struct InstallContext {
    pub app_version: String,
    pub electron_version: String,
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub locale: String,
    pub channel: String,
}

static PATH: LazyLock<Regex> = LazyLock::new(|| {
    let tail = format!(r#"[^{JS_SPACE_CLASS}'"`<>()\[\]{{}},;:]"#);
    static_regex(&format!(
        r"(?:(?P<lead>[A-Za-z]:\\|\\\\|~[\\/])|(?P<pre>^|[^A-Za-z0-9_:.])/){tail}*(?:[\\/]{tail}*)*"
    ))
});

static FILE_URL: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r#"(?-u:\b)(?:file|app)://[^{JS_SPACE_CLASS}'"`<>()]+"#
    ))
});

static QUOTED_PATH: LazyLock<Regex> = LazyLock::new(|| {
    let start = r"(?:/|~[\\/]|[A-Za-z]:\\)";
    let body = r#"[^'"`\n]*"#;
    static_regex(&format!(
        r#"'{start}{body}'|"{start}{body}"|`{start}{body}`"#
    ))
});

static FRAME: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^[{JS_SPACE_CLASS}]*at[{JS_SPACE_CLASS}]+(?:({JS_DOT}+?)[{JS_SPACE_CLASS}]+\()?({JS_DOT}+?)(?::([0-9]+))?(?::([0-9]+))?\)?$"
    ))
});

static ASYNC_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^async[{JS_SPACE_CLASS}]+")));
static SCHEME_PREFIX: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z]+://"));
static FUNCTION_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z0-9_$.<>\[\] ]+$"));
static FILE_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z0-9_.-]+$"));
static ERROR_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z][A-Za-z0-9_]{0,99}$"));
static COUNT_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$"));
static VALUE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$"));

pub fn platform_name() -> &'static str {
    match ostia_base::Platform::current() {
        ostia_base::Platform::Linux => "linux",
        ostia_base::Platform::Darwin => "darwin",
    }
}

pub fn is_count_id(text: &str) -> bool {
    COUNT_ID.is_match(text)
}

pub fn is_value_word(text: &str) -> bool {
    VALUE.is_match(text)
}

pub fn strip_paths(text: &str) -> String {
    let quoted = QUOTED_PATH.replace_all(text, |caps: &Captures| {
        let quote = &caps[0][..1];
        format!("{quote}<path>{quote}")
    });
    let urls = FILE_URL.replace_all(&quoted, "<path>");
    PATH.replace_all(&urls, |caps: &Captures| {
        if caps.name("lead").is_some() {
            "<path>".to_owned()
        } else {
            let pre = caps.name("pre").map_or("", |found| found.as_str());
            format!("{pre}<path>")
        }
    })
    .into_owned()
}

fn base_name(location: &str) -> String {
    let without_async = ASYNC_PREFIX.replace(location, "");
    let without_scheme = SCHEME_PREFIX.replace(&without_async, "");
    let last = without_scheme
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default();
    last.split('?').next().unwrap_or_default().to_owned()
}

fn digits_number(text: &str) -> Option<Number> {
    text.parse::<u64>().ok().map(Number::from).or_else(|| {
        let value = ostia_base::js::js_number(text);
        Number::from_f64(value)
    })
}

pub fn reduce_stack(stack: Option<&str>) -> Vec<StackFrame> {
    let Some(stack) = stack.filter(|stack| !stack.is_empty()) else {
        return Vec::new();
    };
    let mut frames = Vec::new();
    for line in stack.split('\n') {
        let Some(found) = FRAME.captures(line) else {
            continue;
        };
        let function = found
            .get(1)
            .map(|m| m.as_str())
            .filter(|name| !name.is_empty() && FUNCTION_NAME.is_match(name))
            .map(str::to_owned);
        let location = found.get(2).map_or("", |m| m.as_str());
        let file = base_name(location);
        let filename = (!file.is_empty() && FILE_NAME.is_match(&file)).then_some(file);
        let lineno = found.get(3).and_then(|m| digits_number(m.as_str()));
        let colno = found.get(4).and_then(|m| digits_number(m.as_str()));
        if function.is_none() && filename.is_none() && lineno.is_none() && colno.is_none() {
            continue;
        }
        frames.push(StackFrame {
            platform: "node",
            in_app: true,
            function,
            filename,
            lineno,
            colno,
        });
    }
    frames.truncate(TELEMETRY_FRAMES_MAX);
    frames.reverse();
    frames
}

#[derive(Debug, Clone)]
pub struct ErrorInput {
    pub source: ErrorSource,
    pub name: String,
    pub message: String,
    pub stack: Option<String>,
    pub extension: Option<String>,
}

#[derive(Clone)]
pub struct ReportContext {
    pub install_id: String,
    pub context: InstallContext,
    pub now: Clock,
    pub new_id: Arc<dyn Fn() -> String + Send + Sync>,
    pub redact: Arc<dyn Fn(&str) -> String + Send + Sync>,
}

fn sanitize_text(text: &str, redact: &(dyn Fn(&str) -> String + Send + Sync)) -> String {
    clip_printable(&redact(&strip_paths(text)), TELEMETRY_MESSAGE_MAX)
}

pub fn iso_timestamp(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|moment| moment.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

fn context_properties(context: &InstallContext) -> Map<String, Value> {
    let mut properties = Map::new();
    for (key, value) in [
        ("app_version", &context.app_version),
        ("electron_version", &context.electron_version),
        ("os_name", &context.os_name),
        ("os_version", &context.os_version),
        ("arch", &context.arch),
        ("locale", &context.locale),
        ("channel", &context.channel),
    ] {
        properties.insert(key.to_owned(), Value::from(value.as_str()));
    }
    properties.insert("$process_person_profile".to_owned(), Value::Bool(false));
    properties
}

fn report_shell(event: &str, properties: Map<String, Value>, ctx: &ReportContext) -> Value {
    let mut report = Map::new();
    report.insert("uuid".to_owned(), Value::from((ctx.new_id)()));
    report.insert("event".to_owned(), Value::from(event));
    report.insert(
        "distinct_id".to_owned(),
        Value::from(ctx.install_id.as_str()),
    );
    report.insert(
        "timestamp".to_owned(),
        Value::from(iso_timestamp((ctx.now)())),
    );
    report.insert("properties".to_owned(), Value::Object(properties));
    Value::Object(report)
}

pub fn build_error_report(input: &ErrorInput, ctx: &ReportContext) -> Value {
    let frames = reduce_stack(input.stack.as_deref());
    let mut properties = context_properties(&ctx.context);
    properties.insert("source".to_owned(), Value::from(input.source.as_str()));
    if let Some(extension) = input.extension.as_deref().filter(|name| !name.is_empty()) {
        properties.insert("extension".to_owned(), Value::from(extension));
    }
    let mut entry = Map::new();
    entry.insert(
        "type".to_owned(),
        Value::from(if ERROR_NAME.is_match(&input.name) {
            input.name.as_str()
        } else {
            "Error"
        }),
    );
    entry.insert(
        "value".to_owned(),
        Value::from(sanitize_text(&input.message, ctx.redact.as_ref())),
    );
    let mut mechanism = Map::new();
    mechanism.insert("handled".to_owned(), Value::Bool(true));
    entry.insert("mechanism".to_owned(), Value::Object(mechanism));
    if !frames.is_empty() {
        let mut stacktrace = Map::new();
        stacktrace.insert("type".to_owned(), Value::from("raw"));
        stacktrace.insert(
            "frames".to_owned(),
            serde_json::to_value(&frames).unwrap_or_default(),
        );
        entry.insert("stacktrace".to_owned(), Value::Object(stacktrace));
    }
    properties.insert(
        "$exception_list".to_owned(),
        Value::Array(vec![Value::Object(entry)]),
    );
    report_shell("$exception", properties, ctx)
}

#[derive(Debug, Clone, Default)]
pub struct UsageCounts {
    pub usage: Map<String, Value>,
    pub features: Map<String, Value>,
    pub terminal: Map<String, Value>,
    pub extensions: Map<String, Value>,
    pub agents: Map<String, Value>,
}

pub fn empty_usage_counts() -> UsageCounts {
    UsageCounts::default()
}

impl UsageCounts {
    pub fn category(&self, category: TelemetryCategory) -> Option<&Map<String, Value>> {
        match category {
            TelemetryCategory::Errors => None,
            TelemetryCategory::Usage => Some(&self.usage),
            TelemetryCategory::Features => Some(&self.features),
            TelemetryCategory::Terminal => Some(&self.terminal),
            TelemetryCategory::Extensions => Some(&self.extensions),
            TelemetryCategory::Agents => Some(&self.agents),
        }
    }

    pub fn category_mut(&mut self, category: TelemetryCategory) -> Option<&mut Map<String, Value>> {
        match category {
            TelemetryCategory::Errors => None,
            TelemetryCategory::Usage => Some(&mut self.usage),
            TelemetryCategory::Features => Some(&mut self.features),
            TelemetryCategory::Terminal => Some(&mut self.terminal),
            TelemetryCategory::Extensions => Some(&mut self.extensions),
            TelemetryCategory::Agents => Some(&mut self.agents),
        }
    }
}

fn usage_properties(
    counts: &UsageCounts,
    enabled: &TelemetrySettings,
    out: &mut Map<String, Value>,
) {
    for category in USAGE_CATEGORIES {
        if !enabled.get(category) {
            continue;
        }
        let Some(values) = counts.category(category) else {
            continue;
        };
        for (key, value) in values {
            match value {
                Value::Object(ids) => {
                    for (id, n) in ids {
                        out.insert(format!("{}.{key}.{id}", category.as_str()), n.clone());
                    }
                }
                other => {
                    out.insert(format!("{}.{key}", category.as_str()), other.clone());
                }
            }
        }
    }
}

pub fn build_usage_report(
    counts: &UsageCounts,
    enabled: &TelemetrySettings,
    ctx: &ReportContext,
) -> Value {
    let mut properties = context_properties(&ctx.context);
    usage_properties(counts, enabled, &mut properties);
    report_shell("usage", properties, ctx)
}

pub fn is_usage_report(report: &Value) -> bool {
    report.get("event").and_then(Value::as_str) == Some("usage")
}

fn key_prefix(key: &str) -> &str {
    match key.find('.') {
        Some(dot) => &key[..dot],
        None => {
            let mut end = key.len().saturating_sub(1);
            while !key.is_char_boundary(end) {
                end -= 1;
            }
            &key[..end]
        }
    }
}

pub fn report_categories(report: &Value) -> Vec<TelemetryCategory> {
    if !is_usage_report(report) {
        return vec![TelemetryCategory::Errors];
    }
    let found: Vec<TelemetryCategory> = report
        .get("properties")
        .and_then(Value::as_object)
        .map(|properties| {
            properties
                .keys()
                .filter_map(|key| TelemetryCategory::parse_usage(key_prefix(key)))
                .collect()
        })
        .unwrap_or_default();
    TELEMETRY_CATEGORIES
        .into_iter()
        .filter(|category| found.contains(category))
        .collect()
}

pub fn without_categories(report: &Value, disabled: &TelemetrySettings) -> Option<Value> {
    let source = report.get("properties").and_then(Value::as_object)?;
    let mut properties = Map::new();
    let mut kept = false;
    for (key, value) in source {
        match TelemetryCategory::parse_usage(key_prefix(key)) {
            Some(category) if disabled.get(category) => {
                kept = true;
                properties.insert(key.clone(), value.clone());
            }
            Some(_) => {}
            None => {
                properties.insert(key.clone(), value.clone());
            }
        }
    }
    if !kept {
        return None;
    }
    let mut trimmed = report.as_object()?.clone();
    trimmed.insert("properties".to_owned(), Value::Object(properties));
    Some(Value::Object(trimmed))
}

pub fn build_batch(reports: &[Value], api_key: &str) -> String {
    let mut body = Map::new();
    body.insert("api_key".to_owned(), Value::from(api_key));
    body.insert("batch".to_owned(), Value::Array(reports.to_vec()));
    Value::Object(body).to_string()
}

pub fn bucket_count(n: usize) -> &'static str {
    match n {
        0 => "0",
        1 => "1",
        2..=3 => "2-3",
        4..=7 => "4-7",
        _ => "8+",
    }
}
