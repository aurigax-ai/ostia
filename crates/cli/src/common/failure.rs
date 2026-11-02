use ostia_rpc::RpcError;
use serde_json::Value;

pub fn describe_failure(error: &RpcError) -> String {
    let hint = error
        .data
        .as_ref()
        .and_then(|data| data.get("hint"))
        .and_then(Value::as_str);
    match hint {
        Some(hint) => format!("{}. {hint}", error.message),
        None => error.message.clone(),
    }
}
