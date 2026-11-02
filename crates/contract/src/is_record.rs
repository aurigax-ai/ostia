use serde_json::Value;

pub fn is_record(value: &Value) -> bool {
    value.is_object()
}
