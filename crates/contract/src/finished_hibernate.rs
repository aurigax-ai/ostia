use ostia_base::js::js_number;
use serde_json::Value;

pub const DEFAULT_FINISHED_HIBERNATE_MINUTES: i64 = 10;

const FINISHED_HIBERNATE_MINUTES_MAX: f64 = 1440.0;

pub fn finished_hibernate_minutes(raw: Option<&Value>) -> i64 {
    let Some(raw) = raw.filter(|value| !value.is_null()) else {
        return DEFAULT_FINISHED_HIBERNATE_MINUTES;
    };
    let number = js_value_number(raw);
    if !number.is_finite() {
        return DEFAULT_FINISHED_HIBERNATE_MINUTES;
    }
    number.round().clamp(0.0, FINISHED_HIBERNATE_MINUTES_MAX) as i64
}

fn js_value_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number(text),
        Value::Array(items) => array_number(items),
        Value::Object(_) => f64::NAN,
    }
}

fn array_number(items: &[Value]) -> f64 {
    match items {
        [] => 0.0,
        [only] => element_number(only),
        _ => f64::NAN,
    }
}

fn element_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number(text),
        Value::Array(items) => array_number(items),
        Value::Bool(_) | Value::Object(_) => f64::NAN,
    }
}
