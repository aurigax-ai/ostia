use serde_json::{Map, Value};

pub type LogFields = Map<String, Value>;

pub trait AppLog: Send + Sync {
    fn info(&self, event: &str, fields: &LogFields);
    fn warn(&self, event: &str, fields: &LogFields);
    fn error(&self, event: &str, fields: &LogFields);
}
