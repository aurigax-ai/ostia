use chrono::{Local, TimeZone};
use ostia_base::js::{js_number_text, utf16_len};
use ostia_contract::relative_time::{
    RelativeStep, RelativeTimeFormat, RelativeUnit, format_relative,
};
use ostia_contract::view_bindings::{
    Binding, TemplatePart, ViewFilter, ViewFormat, compile_template, is_dangerous_segment,
};
use serde_json::{Map, Value};

use crate::locale_datetime::{Clock, HourDigits, clock_text, medium_date};

pub type ViewScope = Map<String, Value>;

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

fn local_clock(ms: f64) -> Option<chrono::DateTime<Local>> {
    Local.timestamp_millis_opt(ms as i64).single()
}

fn time_text(ms: f64, fmt: &ViewFormat) -> String {
    local_clock(ms)
        .and_then(|at| clock_text(&fmt.locale, at.time(), Clock::Locale, HourDigits::TwoDigit))
        .unwrap_or_default()
}

fn date_text(ms: f64, fmt: &ViewFormat) -> String {
    local_clock(ms)
        .and_then(|at| medium_date(&fmt.locale, at.date_naive()))
        .unwrap_or_default()
}

fn apply_filter(filter: ViewFilter, value: Value, fmt: &ViewFormat) -> Value {
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
            Value::String(finite(&value).map_or_else(String::new, |ms| time_text(ms, fmt)))
        }
        ViewFilter::Date => {
            Value::String(finite(&value).map_or_else(String::new, |ms| date_text(ms, fmt)))
        }
    }
}

fn eval_binding(binding: &Binding, scope: &ViewScope, fmt: &ViewFormat) -> Value {
    let mut value = lookup(scope, &binding.path).cloned().unwrap_or(Value::Null);
    for filter in &binding.filters {
        value = apply_filter(*filter, value, fmt);
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

pub fn resolve_value(template: &str, scope: &ViewScope, fmt: &ViewFormat) -> Value {
    let Ok(parts) = compile_template(template) else {
        return Value::String(String::new());
    };
    if let [TemplatePart::Binding(binding)] = parts.as_slice() {
        return eval_binding(binding, scope, fmt);
    }
    Value::String(
        parts
            .iter()
            .map(|part| match part {
                TemplatePart::Text(text) => text.clone(),
                TemplatePart::Binding(binding) => {
                    display_string(&eval_binding(binding, scope, fmt))
                }
            })
            .collect(),
    )
}

pub fn resolve_text(template: &str, scope: &ViewScope, fmt: &ViewFormat) -> String {
    display_string(&resolve_value(template, scope, fmt))
}

pub fn resolve_args(value: &Value, scope: &ViewScope, fmt: &ViewFormat) -> Value {
    match value {
        Value::String(template) => resolve_value(template, scope, fmt),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| resolve_args(item, scope, fmt))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), resolve_args(item, scope, fmt)))
                .collect(),
        ),
        other => other.clone(),
    }
}
