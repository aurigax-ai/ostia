use serde_json::{Map, Value, json};

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
    Response {
        id: Value,
        outcome: Result<Value, Value>,
    },
    Invalid,
}

pub fn parse_body(body: &[u8]) -> Result<Value, serde_json::Error> {
    serde_json::from_str(&String::from_utf8_lossy(body))
}

fn is_request_id(id: &Value) -> bool {
    id.is_string() || id.is_number()
}

pub fn classify(message: Value) -> Incoming {
    let Value::Object(mut record) = message else {
        return Incoming::Invalid;
    };
    if let Some(method) = record
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        let params = record.remove("params");
        return match record.remove("id") {
            Some(id) if is_request_id(&id) => Incoming::Request { id, method, params },
            None => Incoming::Notification { method, params },
            Some(_) => Incoming::Invalid,
        };
    }
    let Some(id) = record.remove("id") else {
        return Incoming::Invalid;
    };
    if !(is_request_id(&id) || id.is_null()) {
        return Incoming::Invalid;
    }
    if let Some(error) = record.remove("error").filter(|error| !is_falsy(error)) {
        return Incoming::Response {
            id,
            outcome: Err(error),
        };
    }
    match record.remove("result") {
        Some(result) => Incoming::Response {
            id,
            outcome: Ok(result),
        },
        None => Incoming::Invalid,
    }
}

pub fn is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(number) => number.as_f64() == Some(0.0),
        Value::String(text) => text.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    }
}

pub fn normalize_params(params: Option<Value>) -> Value {
    match params {
        None => Value::Object(Map::new()),
        Some(Value::Array(items)) => items
            .into_iter()
            .next()
            .unwrap_or_else(|| Value::Object(Map::new())),
        Some(other) => other,
    }
}

pub fn request_body(id: u64, method: &str, params: Option<&Value>) -> Value {
    match params {
        Some(params) => json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        None => json!({"jsonrpc": "2.0", "id": id, "method": method}),
    }
}

pub fn success_body(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub fn error_body(id: &Value, error: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": error})
}

pub fn notification_body(method: &str, params: &Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}
