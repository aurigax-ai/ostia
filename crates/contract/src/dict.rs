use std::sync::LazyLock;

use ostia_base::js::{js_number_text, static_regex};
use regex::{Captures, Regex};
use serde_json::{Map, Value};

use crate::PRODUCT_DISPLAY_NAME;

const PRODUCT_PLACEHOLDER: &str = "{product}";

pub type Dict = Value;
pub type Locale = String;

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{([A-Za-z0-9_]+)\}"));

static EN: LazyLock<Dict> = LazyLock::new(|| parse(include_str!("../data/dict_en.json")));
static ZH_HANT: LazyLock<Dict> = LazyLock::new(|| parse(include_str!("../data/dict_zh_hant.json")));

fn parse(text: &str) -> Dict {
    serde_json::from_str(text).unwrap_or_default()
}

pub fn en() -> &'static Dict {
    &EN
}

pub fn zh_hant() -> &'static Dict {
    &ZH_HANT
}

pub fn with_product_name(text: &str, product: &str) -> String {
    text.replace(PRODUCT_PLACEHOLDER, product)
}

pub fn with_default_product_name(text: &str) -> String {
    with_product_name(text, PRODUCT_DISPLAY_NAME)
}

pub(crate) fn placeholder_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => number.as_f64().map(js_number_text),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

pub fn fmt(template: &str, vars: &Value) -> String {
    PLACEHOLDER
        .replace_all(template, |captures: &Captures| {
            vars.get(&captures[1])
                .and_then(placeholder_text)
                .unwrap_or_else(|| captures[0].to_owned())
        })
        .into_owned()
}

fn merge_strings(
    base: &Map<String, Value>,
    catalog: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    base.iter()
        .map(|(key, value)| {
            let translated = catalog.and_then(|entries| entries.get(key));
            let merged = match value {
                Value::String(text) => Value::String(with_default_product_name(
                    translated.and_then(Value::as_str).unwrap_or(text),
                )),
                Value::Object(inner) => {
                    Value::Object(merge_strings(inner, translated.and_then(Value::as_object)))
                }
                other => other.clone(),
            };
            (key.clone(), merged)
        })
        .collect()
}

pub fn merge_catalog(catalog: &Value) -> Dict {
    let base = en().as_object().cloned().unwrap_or_default();
    Value::Object(merge_strings(&base, catalog.as_object()))
}
