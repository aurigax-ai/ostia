use ostia_base::js::js_trim;
use ostia_base::js_json::parse_js_json;
use serde_json::{Map, Value};

use crate::utf16_prefix::utf16_prefix;

const MESSAGE_MAX: usize = 300;

pub fn parse_payload(raw: &str) -> Map<String, Value> {
    match parse_js_json(raw) {
        Ok(Value::Object(record)) => record,
        _ => Map::new(),
    }
}

pub fn text(value: &Value) -> String {
    value.as_str().map_or_else(String::new, |text| {
        utf16_prefix(js_trim(text), MESSAGE_MAX).to_owned()
    })
}

pub fn first_question(input: &Value) -> String {
    input
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|questions| questions.first())
        .and_then(|first| first.get("question"))
        .map_or_else(String::new, text)
}
