#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::is_record::is_record;
use serde_json::{Value, json};

#[test]
fn accepts_an_object_and_refuses_everything_else() {
    assert!(is_record(&json!({})));
    assert!(is_record(&json!({"a": 1})));
    let bad = [
        Value::Null,
        json!([]),
        json!([{"a": 1}]),
        json!("text"),
        json!(1),
        json!(true),
    ];
    for value in bad {
        assert!(!is_record(&value), "{value}");
    }
}
