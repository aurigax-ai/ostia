use ostia_base::js::utf16_len;
use serde_json::{Map, Value};

pub type Record = Map<String, Value>;

const ID_MAX: usize = 256;

pub fn text<'a>(record: &'a Record, key: &str) -> Option<&'a str> {
    record.get(key)?.as_str()
}

pub fn is_true(record: &Record, key: &str) -> bool {
    record.get(key) == Some(&Value::Bool(true))
}

pub fn copy_text(record: &Record, key: &str) -> Option<String> {
    text(record, key)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub fn id_text(value: Option<&Value>) -> Option<&str> {
    value?
        .as_str()
        .filter(|id| !id.is_empty() && utf16_len(id) <= ID_MAX)
}
