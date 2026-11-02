use serde_json::Value;

pub const BROWSE_WORLD_ID: u32 = 1025;

pub fn js_args(values: &[Value]) -> String {
    values
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}
