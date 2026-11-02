use serde_json::{Map, Value, json};

pub mod codes {
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
}

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
    thrown: bool,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
            thrown: false,
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(codes::INVALID_REQUEST, message)
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(codes::INVALID_PARAMS, message)
    }

    pub fn method_not_found(message: impl Into<String>) -> Self {
        Self::new(codes::METHOD_NOT_FOUND, message)
    }

    pub fn thrown(detail: impl std::fmt::Display) -> Self {
        Self {
            thrown: true,
            ..Self::new(codes::INTERNAL_ERROR, detail.to_string())
        }
    }

    pub fn into_reply(self, method: &str) -> Self {
        if !self.thrown {
            return self;
        }
        Self {
            message: format!("Request {method} failed with message: {}", self.message),
            thrown: false,
            ..self
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn with_hint(self, hint: String) -> Self {
        self.with_data(json!({ "hint": hint }))
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("code".to_owned(), json!(self.code));
        out.insert("message".to_owned(), json!(self.message));
        if let Some(data) = &self.data {
            out.insert("data".to_owned(), data.clone());
        }
        Value::Object(out)
    }

    pub fn from_json(value: &Value) -> Self {
        Self {
            code: value
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or(codes::INTERNAL_ERROR),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            data: value.get("data").cloned(),
            thrown: false,
        }
    }
}

impl From<ostia_base::Error> for RpcError {
    fn from(error: ostia_base::Error) -> Self {
        Self::thrown(error)
    }
}
