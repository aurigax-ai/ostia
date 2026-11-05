use std::sync::LazyLock;

use ostia_base::js::{js_number_text, js_trim, static_regex, utf16_len};
use regex::Regex;
use serde_json::{Map, Value};

use crate::proto_guard::is_dangerous_segment;
use crate::relative_time::{RelativeStep, RelativeTimeFormat, RelativeUnit, format_relative};
use crate::string_enum::{StringEnum, string_enum};

string_enum!(ViewFilter {
    Upper = "upper",
    Lower = "lower",
    Count = "count",
    Not = "not",
    Relative = "relative",
    Time = "time",
    Date = "date",
});

pub const VIEW_FILTERS: &[&str] = ViewFilter::ALL;

#[derive(Debug, Clone, PartialEq)]
pub struct ViewFormat {
    pub now: f64,
    pub locale: String,
}

pub type ViewScope = Map<String, Value>;

pub trait ViewDates {
    fn time(&self, ms: f64, locale: &str) -> String;
    fn date(&self, ms: f64, locale: &str) -> String;
}

pub struct NoDates;

impl ViewDates for NoDates {
    fn time(&self, _ms: f64, _locale: &str) -> String {
        String::new()
    }

    fn date(&self, _ms: f64, _locale: &str) -> String {
        String::new()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub path: Vec<String>,
    pub filters: Vec<ViewFilter>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TemplatePart {
    Text(String),
    Binding(Binding),
}

static SEGMENT: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]{1,4})$"));
static IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z_][A-Za-z0-9_]*$"));
static BINDING: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{\{([^{}]*)\}\}"));

pub fn is_identifier(name: &str) -> bool {
    IDENTIFIER.is_match(name) && !is_dangerous_segment(name)
}

pub fn parse_path(raw: &str) -> Result<Vec<String>, String> {
    let text = js_trim(raw);
    if text.is_empty() {
        return Err("empty path".to_owned());
    }
    for segment in text.split('.') {
        if !SEGMENT.is_match(segment) {
            return Err(format!("'{text}' is not a property path"));
        }
        if is_dangerous_segment(segment) {
            return Err(format!("'{segment}' is not allowed in a path"));
        }
    }
    let segments: Vec<&str> = text.split('.').collect();
    if !segments
        .first()
        .is_some_and(|first| IDENTIFIER.is_match(first))
    {
        return Err(format!("'{text}' must start with a name"));
    }
    Ok(segments.into_iter().map(str::to_owned).collect())
}

fn parse_binding(inner: &str) -> Result<Binding, String> {
    let mut pieces = inner.split('|');
    let path = parse_path(pieces.next().unwrap_or_default())?;
    let mut filters = Vec::new();
    for raw in pieces {
        let name = js_trim(raw);
        let filter = ViewFilter::parse(name).ok_or_else(|| {
            format!(
                "unknown filter '{name}' (known: {})",
                ViewFilter::ALL.join(", ")
            )
        })?;
        filters.push(filter);
    }
    Ok(Binding { path, filters })
}

fn has_unbalanced_braces(literal: &str) -> bool {
    literal.contains("{{") || literal.contains("}}")
}

pub fn compile_template(template: &str) -> Result<Vec<TemplatePart>, String> {
    let mut parts = Vec::new();
    let mut last = 0;
    for captures in BINDING.captures_iter(template) {
        let (Some(whole), Some(inner)) = (captures.get(0), captures.get(1)) else {
            continue;
        };
        let literal = &template[last..whole.start()];
        if has_unbalanced_braces(literal) {
            return Err("unbalanced {{ }}".to_owned());
        }
        if !literal.is_empty() {
            parts.push(TemplatePart::Text(literal.to_owned()));
        }
        parts.push(TemplatePart::Binding(parse_binding(inner.as_str())?));
        last = whole.end();
    }
    let tail = &template[last..];
    if has_unbalanced_braces(tail) {
        return Err("unbalanced {{ }}".to_owned());
    }
    if !tail.is_empty() {
        parts.push(TemplatePart::Text(tail.to_owned()));
    }
    Ok(parts)
}

pub fn has_bindings(template: &str) -> bool {
    compile_template(template).is_ok_and(|parts| {
        parts
            .iter()
            .any(|part| matches!(part, TemplatePart::Binding(_)))
    })
}

pub fn bindings_of(template: &str) -> Vec<Binding> {
    compile_template(template)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|part| match part {
            TemplatePart::Binding(binding) => Some(binding),
            TemplatePart::Text(_) => None,
        })
        .collect()
}

const RELATIVE_STEPS: [RelativeStep; 4] = [
    (RelativeUnit::Day, 86_400_000.0),
    (RelativeUnit::Hour, 3_600_000.0),
    (RelativeUnit::Minute, 60_000.0),
    (RelativeUnit::Second, 1000.0),
];

fn step<'a>(value: &'a Value, segment: &str) -> Option<&'a Value> {
    if is_dangerous_segment(segment) {
        return None;
    }
    match value {
        Value::Array(items) => {
            if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            items.get(segment.parse::<usize>().ok()?)
        }
        Value::Object(map) => map.get(segment),
        _ => None,
    }
}

pub fn lookup<'a>(scope: &'a ViewScope, path: &[String]) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    if is_dangerous_segment(first) {
        return None;
    }
    let mut value = scope.get(first)?;
    for segment in rest {
        value = step(value, segment)?;
    }
    Some(value)
}

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(_) => true,
    }
}

fn count(value: &Value) -> Value {
    let size = match value {
        Value::Array(items) => items.len(),
        Value::String(text) => utf16_len(text),
        Value::Object(map) => map.len(),
        _ => 0,
    };
    Value::from(size)
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

fn relative(ms: f64, fmt: &ViewFormat) -> String {
    format_relative(
        ms - fmt.now,
        &RELATIVE_STEPS,
        &RelativeTimeFormat::new(&fmt.locale),
    )
    .unwrap_or_default()
}

fn apply_filter(
    filter: ViewFilter,
    value: Value,
    fmt: &ViewFormat,
    dates: &dyn ViewDates,
) -> Value {
    match filter {
        ViewFilter::Upper => match value {
            Value::String(text) => Value::String(text.to_uppercase()),
            other => other,
        },
        ViewFilter::Lower => match value {
            Value::String(text) => Value::String(text.to_lowercase()),
            other => other,
        },
        ViewFilter::Count => count(&value),
        ViewFilter::Not => Value::Bool(!truthy(&value)),
        ViewFilter::Relative => {
            Value::String(finite(&value).map_or_else(String::new, |ms| relative(ms, fmt)))
        }
        ViewFilter::Time => {
            Value::String(finite(&value).map_or_else(String::new, |ms| dates.time(ms, &fmt.locale)))
        }
        ViewFilter::Date => {
            Value::String(finite(&value).map_or_else(String::new, |ms| dates.date(ms, &fmt.locale)))
        }
    }
}

fn eval_binding(
    binding: &Binding,
    scope: &ViewScope,
    fmt: &ViewFormat,
    dates: &dyn ViewDates,
) -> Option<Value> {
    let mut value = lookup(scope, &binding.path).cloned();
    for filter in &binding.filters {
        value = match (filter, value) {
            (ViewFilter::Upper | ViewFilter::Lower, None) => None,
            (_, found) => Some(apply_filter(
                *filter,
                found.unwrap_or(Value::Null),
                fmt,
                dates,
            )),
        };
    }
    value
}

fn display_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number
            .as_f64()
            .filter(|n| n.is_finite())
            .map_or_else(String::new, js_number_text),
        Value::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

fn resolve_template(
    template: &str,
    scope: &ViewScope,
    fmt: &ViewFormat,
    dates: &dyn ViewDates,
) -> Option<Value> {
    let Ok(parts) = compile_template(template) else {
        return Some(Value::String(String::new()));
    };
    if let [TemplatePart::Binding(binding)] = parts.as_slice() {
        return eval_binding(binding, scope, fmt, dates);
    }
    Some(Value::String(
        parts
            .iter()
            .map(|part| match part {
                TemplatePart::Text(text) => text.clone(),
                TemplatePart::Binding(binding) => {
                    display_string(&eval_binding(binding, scope, fmt, dates).unwrap_or(Value::Null))
                }
            })
            .collect(),
    ))
}

pub fn resolve_value_with(
    template: &str,
    scope: &ViewScope,
    fmt: &ViewFormat,
    dates: &dyn ViewDates,
) -> Value {
    resolve_template(template, scope, fmt, dates).unwrap_or(Value::Null)
}

pub fn resolve_text_with(
    template: &str,
    scope: &ViewScope,
    fmt: &ViewFormat,
    dates: &dyn ViewDates,
) -> String {
    display_string(&resolve_value_with(template, scope, fmt, dates))
}

fn resolve_arg(
    value: &Value,
    scope: &ViewScope,
    fmt: &ViewFormat,
    dates: &dyn ViewDates,
) -> Option<Value> {
    match value {
        Value::String(template) => resolve_template(template, scope, fmt, dates),
        Value::Array(items) => Some(Value::Array(
            items
                .iter()
                .map(|item| resolve_arg(item, scope, fmt, dates).unwrap_or(Value::Null))
                .collect(),
        )),
        Value::Object(map) => Some(Value::Object(
            map.iter()
                .filter_map(|(key, item)| {
                    resolve_arg(item, scope, fmt, dates).map(|found| (key.clone(), found))
                })
                .collect(),
        )),
        other => Some(other.clone()),
    }
}

pub fn resolve_args_with(
    value: &Value,
    scope: &ViewScope,
    fmt: &ViewFormat,
    dates: &dyn ViewDates,
) -> Value {
    resolve_arg(value, scope, fmt, dates).unwrap_or(Value::Null)
}

pub fn resolve_value(template: &str, scope: &ViewScope, fmt: &ViewFormat) -> Value {
    resolve_value_with(template, scope, fmt, &NoDates)
}

pub fn resolve_text(template: &str, scope: &ViewScope, fmt: &ViewFormat) -> String {
    resolve_text_with(template, scope, fmt, &NoDates)
}

pub fn resolve_args(value: &Value, scope: &ViewScope, fmt: &ViewFormat) -> Value {
    resolve_args_with(value, scope, fmt, &NoDates)
}
