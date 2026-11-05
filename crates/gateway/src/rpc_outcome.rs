use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum RpcOutcome {
    Ok(Value),
    Refused {
        code: i64,
        message: String,
        data: Option<Value>,
    },
}

impl RpcOutcome {
    pub fn refused(code: i64, message: &str) -> Self {
        Self::Refused {
            code,
            message: message.to_owned(),
            data: None,
        }
    }
}
