use std::future::Future;
use std::pin::Pin;

use ostia_contract::assist::AssistPoint;
use serde_json::{Map, Value};

use crate::redaction::Redactor;
use crate::redaction_scan::{ScanError, SecretScan};

const DEEP_DEPTH_MAX: usize = 8;

struct Tally<'r, S> {
    redactor: &'r Redactor<S>,
    count: usize,
}

impl<S: SecretScan + Send + Sync> Tally<'_, S> {
    async fn value(&mut self, value: &Value) -> Result<Value, ScanError> {
        match value {
            Value::String(text) => {
                let result = self.redactor.redact(text).await?;
                self.count += result.count;
                Ok(Value::String(result.text))
            }
            _ if self.redactor.enabled() => Err(ScanError::failed()),
            other => Ok(other.clone()),
        }
    }

    async fn field(&mut self, map: &mut Map<String, Value>, key: &str) -> Result<(), ScanError> {
        match map.get(key).cloned() {
            Some(current) => {
                let redacted = self.value(&current).await?;
                map.insert(key.to_owned(), redacted);
                Ok(())
            }
            None if self.redactor.enabled() => Err(ScanError::failed()),
            None => Ok(()),
        }
    }

    async fn items(&mut self, array: &Value, key: &str) -> Result<Value, ScanError> {
        let mut out = Vec::new();
        for item in array.as_array().ok_or_else(ScanError::failed)? {
            let mut object = object_of(item)?;
            self.field(&mut object, key).await?;
            out.push(Value::Object(object));
        }
        Ok(Value::Array(out))
    }

    async fn items_at(
        &mut self,
        map: &mut Map<String, Value>,
        list: &str,
        key: &str,
    ) -> Result<(), ScanError> {
        let Some(array) = map.get(list).filter(|value| is_truthy(value)).cloned() else {
            return Ok(());
        };
        let redacted = self.items(&array, key).await?;
        map.insert(list.to_owned(), redacted);
        Ok(())
    }

    fn deep<'a>(
        &'a mut self,
        value: &'a Value,
        depth: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ScanError>> + Send + 'a>> {
        Box::pin(async move {
            if value.is_string() {
                return self.value(value).await;
            }
            if depth > DEEP_DEPTH_MAX {
                return Ok(value.clone());
            }
            match value {
                Value::Array(items) => {
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        out.push(self.deep(item, depth + 1).await?);
                    }
                    Ok(Value::Array(out))
                }
                Value::Object(object) => {
                    let mut out = Map::new();
                    for (key, item) in object {
                        out.insert(key.clone(), self.deep(item, depth + 1).await?);
                    }
                    Ok(Value::Object(out))
                }
                other => Ok(other.clone()),
            }
        })
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

fn object_of(value: &Value) -> Result<Map<String, Value>, ScanError> {
    value.as_object().cloned().ok_or_else(ScanError::failed)
}

async fn completion<S: SecretScan + Send + Sync>(
    tally: &mut Tally<'_, S>,
    request: &Value,
) -> Result<Value, ScanError> {
    let mut out = object_of(request)?;
    tally.field(&mut out, "prefix").await?;
    tally.field(&mut out, "suffix").await?;
    tally.items_at(&mut out, "neighbors", "text").await?;
    Ok(Value::Object(out))
}

async fn terminal<S: SecretScan + Send + Sync>(
    tally: &mut Tally<'_, S>,
    request: &Value,
) -> Result<Value, ScanError> {
    let mut out = object_of(request)?;
    tally.field(&mut out, "line").await?;
    tally.items_at(&mut out, "history", "command").await?;
    tally.items_at(&mut out, "context", "text").await?;
    Ok(Value::Object(out))
}

async fn tool<S: SecretScan + Send + Sync>(
    tally: &mut Tally<'_, S>,
    tool: &Value,
) -> Result<Value, ScanError> {
    let mut out = object_of(tool)?;
    for key in ["output", "error"] {
        if out.contains_key(key) {
            tally.field(&mut out, key).await?;
        }
    }
    Ok(Value::Object(out))
}

async fn chat_message<S: SecretScan + Send + Sync>(
    tally: &mut Tally<'_, S>,
    message: &Value,
) -> Result<Value, ScanError> {
    let mut out = object_of(message)?;
    tally.field(&mut out, "content").await?;
    if let Some(tools) = out.get("tools").filter(|value| is_truthy(value)).cloned() {
        let mut redacted = Vec::new();
        for item in tools.as_array().ok_or_else(ScanError::failed)? {
            redacted.push(tool(tally, item).await?);
        }
        out.insert("tools".to_owned(), Value::Array(redacted));
    }
    Ok(Value::Object(out))
}

async fn chat<S: SecretScan + Send + Sync>(
    tally: &mut Tally<'_, S>,
    request: &Value,
) -> Result<Value, ScanError> {
    let mut out = object_of(request)?;
    let messages = out.get("messages").cloned().unwrap_or(Value::Null);
    let mut redacted = Vec::new();
    for message in messages.as_array().ok_or_else(ScanError::failed)? {
        redacted.push(chat_message(tally, message).await?);
    }
    let context = out.get("context").cloned().unwrap_or(Value::Null);
    let context = tally.items(&context, "text").await?;
    out.insert("messages".to_owned(), Value::Array(redacted));
    out.insert("context".to_owned(), context);
    Ok(Value::Object(out))
}

pub async fn redact_assist_request<S: SecretScan + Send + Sync>(
    point: AssistPoint,
    request: &Value,
    redactor: &Redactor<S>,
) -> Result<(Value, usize), ScanError> {
    let mut tally = Tally { redactor, count: 0 };
    let out = match point {
        AssistPoint::Input => {
            let mut out = object_of(request)?;
            tally.field(&mut out, "text").await?;
            Value::Object(out)
        }
        AssistPoint::Command => {
            let mut out = object_of(request)?;
            tally.field(&mut out, "query").await?;
            Value::Object(out)
        }
        AssistPoint::Completion => completion(&mut tally, request).await?,
        AssistPoint::Terminal => terminal(&mut tally, request).await?,
        AssistPoint::Chat => chat(&mut tally, request).await?,
    };
    Ok((out, tally.count))
}

async fn part<S: SecretScan + Send + Sync>(
    tally: &mut Tally<'_, S>,
    part: &Value,
    role: Option<&str>,
) -> Result<Value, ScanError> {
    let mut out = object_of(part)?;
    let is_text = out.get("type").and_then(Value::as_str) == Some("text")
        && out.get("text").is_some_and(Value::is_string);
    if is_text {
        if role == Some("user") {
            tally.field(&mut out, "text").await?;
        }
        return Ok(Value::Object(out));
    }
    if let Some(output) = out.get("output").cloned() {
        let redacted = tally.deep(&output, 0).await?;
        out.insert("output".to_owned(), redacted);
    }
    if out.get("errorText").is_some_and(Value::is_string) {
        tally.field(&mut out, "errorText").await?;
    }
    Ok(Value::Object(out))
}

async fn session_message<S: SecretScan + Send + Sync>(
    tally: &mut Tally<'_, S>,
    message: &Value,
) -> Result<Value, ScanError> {
    let mut out = object_of(message)?;
    let role = out.get("role").and_then(Value::as_str).map(str::to_owned);
    let mut parts = Vec::new();
    let source = out.get("parts").cloned().unwrap_or(Value::Null);
    for item in source.as_array().ok_or_else(ScanError::failed)? {
        parts.push(part(tally, item, role.as_deref()).await?);
    }
    out.insert("parts".to_owned(), Value::Array(parts));
    let context = out
        .get("metadata")
        .and_then(|metadata| metadata.get("context"))
        .filter(|value| is_truthy(value))
        .cloned();
    if let Some(context) = context {
        let items = tally.items(&context, "text").await?;
        let mut metadata = object_of(out.get("metadata").unwrap_or(&Value::Null))?;
        metadata.insert("context".to_owned(), items);
        out.insert("metadata".to_owned(), Value::Object(metadata));
    }
    Ok(Value::Object(out))
}

pub async fn redact_chat_session<S: SecretScan + Send + Sync>(
    session: &Value,
    redactor: &Redactor<S>,
) -> Result<Value, ScanError> {
    let mut tally = Tally { redactor, count: 0 };
    let mut out = object_of(session)?;
    let source = out.get("messages").cloned().unwrap_or(Value::Null);
    let mut messages = Vec::new();
    for message in source.as_array().ok_or_else(ScanError::failed)? {
        messages.push(session_message(&mut tally, message).await?);
    }
    tally.field(&mut out, "title").await?;
    out.insert("messages".to_owned(), Value::Array(messages));
    Ok(Value::Object(out))
}
