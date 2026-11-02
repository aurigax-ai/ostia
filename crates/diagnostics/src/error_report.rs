use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;

use crate::app_log::{AppLog, LogFields};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Thrown {
    Error { name: String, code: Option<String> },
    Value { type_of: String },
}

pub fn is_errno(thrown: &Thrown) -> bool {
    let Thrown::Error {
        code: Some(code), ..
    } = thrown
    else {
        return false;
    };
    code.strip_prefix('E').is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
    })
}

pub fn expect_errno(thrown: &Thrown) -> Result<(), Thrown> {
    if is_errno(thrown) {
        Ok(())
    } else {
        Err(thrown.clone())
    }
}

#[derive(Default)]
pub struct ErrorSink {
    sink: Mutex<Option<Arc<dyn AppLog>>>,
}

impl ErrorSink {
    pub fn set(&self, log: Option<Arc<dyn AppLog>>) {
        *self.sink.lock() = log;
    }

    pub fn report(&self, scope: &str, thrown: &Thrown) {
        let name = match thrown {
            Thrown::Error { name, .. } => name,
            Thrown::Value { type_of } => type_of,
        };
        let code = match thrown {
            Thrown::Error {
                code: Some(code), ..
            } if is_errno(thrown) => Some(code),
            _ => None,
        };
        let sink = self.sink.lock().clone();
        match sink {
            Some(log) => {
                let mut fields = LogFields::new();
                fields.insert("scope".to_owned(), Value::from(scope));
                fields.insert("name".to_owned(), Value::from(name.as_str()));
                if let Some(code) = code {
                    fields.insert("code".to_owned(), Value::from(code.as_str()));
                }
                log.warn("unexpected-error", &fields);
            }
            None => tracing::error!(scope, name = %name, code = ?code, "unexpected-error"),
        }
    }
}
