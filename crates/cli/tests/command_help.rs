#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::commands::{CommandDescriptor, TargetMode};
use serde_json::{Value, json};

use ostia_cli::common::command_help::{command_help, wants_help};

fn descriptor(args_schema: Option<Value>) -> CommandDescriptor {
    CommandDescriptor {
        id: "pane.close".to_owned(),
        title: "Close pane".to_owned(),
        category: None,
        hidden: false,
        args_schema,
        result_schema: None,
        capabilities: Vec::new(),
        target: TargetMode::Explicit,
        extension: None,
    }
}

#[test]
fn accepts_help_and_dash_h_only() {
    assert!(wants_help(Some("--help")));
    assert!(wants_help(Some("-h")));
    assert!(!wants_help(Some("{\"id\":\"x\"}")));
    assert!(!wants_help(Some("-1")));
    assert!(!wants_help(None));
}

#[test]
fn prints_the_title_usage_and_the_args_schema() {
    let text = command_help(&descriptor(Some(
        json!({"type": "object", "properties": {"id": {"type": "string"}}}),
    )));
    assert!(text.contains("pane.close: Close pane"), "{text}");
    assert!(
        text.contains("usage: ostia pane.close [json-args]"),
        "{text}"
    );
    assert!(text.contains("\"properties\""), "{text}");
}

#[test]
fn says_so_when_the_command_takes_no_arguments() {
    assert!(command_help(&descriptor(None)).contains("takes no arguments"));
}

#[test]
fn prints_the_lines_in_order_with_the_schema_as_compact_json() {
    let text = command_help(&descriptor(Some(
        json!({"type": "object", "required": ["id"]}),
    )));
    assert_eq!(
        text,
        "pane.close: Close pane\n\nusage: ostia pane.close [json-args]\n\nargs (JSON):\n{\"type\":\"object\",\"required\":[\"id\"]}"
    );
    assert_eq!(
        command_help(&descriptor(None)),
        "pane.close: Close pane\n\nusage: ostia pane.close [json-args]\n\ntakes no arguments"
    );
}
