use serde_json::{Map, Value, json};

pub fn rpc_result(id: &Value, result: &Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
}

pub fn rpc_error(id: &Value, code: i64, message: &str, data: Option<&Value>) -> String {
    let mut error = Map::new();
    error.insert("code".to_owned(), json!(code));
    error.insert("message".to_owned(), json!(message));
    if let Some(data) = data {
        error.insert("data".to_owned(), data.clone());
    }
    json!({"jsonrpc": "2.0", "id": id, "error": Value::Object(error)}).to_string()
}
