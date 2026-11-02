#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_diagnostics::app_log::{AppLog, LogFields};
use ostia_diagnostics::error_report::{ErrorSink, Thrown, expect_errno, is_errno};
use parking_lot::Mutex;
use serde_json::{Value, json};

#[derive(Default)]
struct Warnings {
    seen: Mutex<Vec<(String, LogFields)>>,
}

impl AppLog for Warnings {
    fn info(&self, _event: &str, _fields: &LogFields) {}

    fn warn(&self, event: &str, fields: &LogFields) {
        self.seen.lock().push((event.to_owned(), fields.clone()));
    }

    fn error(&self, _event: &str, _fields: &LogFields) {}
}

fn error(name: &str, code: Option<&str>) -> Thrown {
    Thrown::Error {
        name: name.to_owned(),
        code: code.map(str::to_owned),
    }
}

#[test]
fn writes_the_scope_error_name_and_code_never_the_message() {
    let warnings = Arc::new(Warnings::default());
    let sink = ErrorSink::default();
    sink.set(Some(warnings.clone()));
    sink.report("fsText", &error("Error", Some("EIO")));
    let seen = warnings.seen.lock();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "unexpected-error");
    assert_eq!(
        Value::Object(seen[0].1.clone()),
        json!({"scope": "fsText", "name": "Error", "code": "EIO"})
    );
}

#[test]
fn tells_file_system_errors_from_other_errors() {
    assert!(is_errno(&error("Error", Some("ENOENT"))));
    assert!(!is_errno(&error("TypeError", None)));
    assert!(!is_errno(&error("TypeError", Some("ERR_INVALID_ARG_TYPE"))));
    assert!(!is_errno(&Thrown::Value {
        type_of: "string".to_owned()
    }));
}

#[test]
fn names_a_thrown_value_that_is_not_an_error_by_its_type_and_leaves_the_code_out() {
    let warnings = Arc::new(Warnings::default());
    let sink = ErrorSink::default();
    sink.set(Some(warnings.clone()));
    sink.report(
        "scan",
        &Thrown::Value {
            type_of: "string".to_owned(),
        },
    );
    assert_eq!(
        Value::Object(warnings.seen.lock()[0].1.clone()),
        json!({"scope": "scan", "name": "string"})
    );
}

#[test]
fn stops_writing_when_the_sink_is_cleared() {
    let warnings = Arc::new(Warnings::default());
    let sink = ErrorSink::default();
    sink.set(Some(warnings.clone()));
    sink.set(None);
    sink.report("scan", &error("Error", Some("EIO")));
    assert!(warnings.seen.lock().is_empty());
}

#[test]
fn lets_a_file_system_error_pass_and_gives_any_other_error_back() {
    assert!(expect_errno(&error("Error", Some("ENOENT"))).is_ok());
    let other = error("TypeError", None);
    assert_eq!(expect_errno(&other), Err(other.clone()));
}
