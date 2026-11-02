use std::future::Future;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

pub const REQUEST_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, thiserror::Error)]
#[error("{0} timed out")]
pub struct TimedOut(String);

pub async fn cancelled(token: Option<&CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

pub fn fail(error: &str, message: Option<&str>) -> Value {
    let mut out = Map::new();
    out.insert("ok".to_owned(), Value::Bool(false));
    out.insert("error".to_owned(), Value::String(error.to_owned()));
    if let Some(message) = message.filter(|message| !message.is_empty()) {
        out.insert("message".to_owned(), Value::String(message.to_owned()));
    }
    Value::Object(out)
}

pub fn normalize_result(raw: &Value) -> Value {
    if let Some(record) = raw.as_object()
        && let Some(ok) = record.get("ok").and_then(Value::as_bool)
    {
        if !ok {
            let error = record
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            let message = record.get("message").and_then(Value::as_str);
            let mut failed = fail(error, message);
            if let (Some(data), Some(map)) = (record.get("data"), failed.as_object_mut()) {
                map.insert("data".to_owned(), data.clone());
            }
            return failed;
        }
        let mut out = Map::new();
        out.insert("ok".to_owned(), Value::Bool(true));
        if let Some(text) = record.get("text").filter(|text| text.is_string()) {
            out.insert("text".to_owned(), text.clone());
        }
        if let Some(data) = record.get("data") {
            out.insert("data".to_owned(), data.clone());
        }
        return Value::Object(out);
    }
    let mut out = Map::new();
    out.insert("ok".to_owned(), Value::Bool(true));
    if !raw.is_null() {
        out.insert("data".to_owned(), raw.clone());
    }
    Value::Object(out)
}

pub fn with_timeout<F: Future>(
    call: F,
    ms: u64,
    what: &str,
) -> impl Future<Output = Result<F::Output, TimedOut>> {
    let timer = tokio::time::sleep(Duration::from_millis(ms));
    let what = what.to_owned();
    async move {
        tokio::pin!(timer);
        tokio::pin!(call);
        tokio::select! {
            biased;
            () = &mut timer => Err(TimedOut(what)),
            done = &mut call => Ok(done),
        }
    }
}
