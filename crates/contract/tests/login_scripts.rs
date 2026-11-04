#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use ostia_contract::login_scripts::{fill_script, read_script};
use serde_json::{Value, json};

struct Run {
    result: Value,
    inputs: Vec<Value>,
}

fn run(script: &str, inputs: Value) -> Run {
    let harness =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/browser/loginHarness.mjs");
    let mut child = Command::new("node")
        .arg(harness)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"script": script, "inputs": inputs})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    Run {
        result: report["result"].clone(),
        inputs: report["inputs"].as_array().unwrap().clone(),
    }
}

fn value_of(run: &Run, index: usize) -> &str {
    run.inputs[index]["value"].as_str().unwrap()
}

fn events_of(run: &Run, index: usize) -> Vec<&str> {
    run.inputs[index]["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event.as_str().unwrap())
        .collect()
}

#[test]
fn fills_the_username_and_the_password_and_reports_both() {
    let run = run(
        &fill_script("ada", "s3cret"),
        json!([{"type": "text"}, {"type": "password"}]),
    );
    assert_eq!(run.result, json!({"filled": true, "user": true}));
    assert_eq!(value_of(&run, 0), "ada");
    assert_eq!(value_of(&run, 1), "s3cret");
}

#[test]
fn focuses_each_field_and_fires_input_then_change() {
    let run = run(
        &fill_script("ada", "pw"),
        json!([{"type": "text"}, {"type": "password"}]),
    );
    for index in 0..2 {
        assert_eq!(events_of(&run, index), ["input", "change"], "field {index}");
        assert_eq!(run.inputs[index]["focused"], json!(true), "field {index}");
    }
}

#[test]
fn reports_not_filled_and_touches_nothing_when_the_page_has_no_visible_password_field() {
    let run = run(
        &fill_script("ada", "pw"),
        json!([{"type": "text"}, {"type": "password", "visible": false}]),
    );
    assert_eq!(run.result, json!({"filled": false}));
    assert_eq!(value_of(&run, 0), "");
    assert_eq!(value_of(&run, 1), "");
    assert_eq!(events_of(&run, 0), Vec::<&str>::new());
}

#[test]
fn skips_a_password_field_hidden_by_its_style_and_uses_the_next_visible_one() {
    let run = run(
        &fill_script("ada", "pw"),
        json!([
            {"type": "password", "hidden": true},
            {"type": "text"},
            {"type": "password"}
        ]),
    );
    assert_eq!(run.result, json!({"filled": true, "user": true}));
    assert_eq!(value_of(&run, 0), "");
    assert_eq!(value_of(&run, 1), "ada");
    assert_eq!(value_of(&run, 2), "pw");
}

#[test]
fn prefers_a_username_autocomplete_or_an_email_field_over_a_nearer_text_field() {
    let by_autocomplete = run(
        &fill_script("ada", "pw"),
        json!([
            {"type": "text", "autocomplete": "username"},
            {"type": "text"},
            {"type": "password"}
        ]),
    );
    assert_eq!(value_of(&by_autocomplete, 0), "ada");
    assert_eq!(value_of(&by_autocomplete, 1), "");
    let by_email = run(
        &fill_script("ada@x.test", "pw"),
        json!([{"type": "text"}, {"type": "email"}, {"type": "text"}, {"type": "password"}]),
    );
    assert_eq!(value_of(&by_email, 1), "ada@x.test");
    assert_eq!(value_of(&by_email, 0), "");
    assert_eq!(value_of(&by_email, 2), "");
}

#[test]
fn falls_back_to_the_nearest_text_like_field_before_the_password() {
    let table = [("text", 1), ("tel", 1), ("", 1)];
    for (kind, expected) in table {
        let run = run(
            &fill_script("ada", "pw"),
            json!([{"type": "text"}, {"type": kind}, {"type": "password"}]),
        );
        assert_eq!(value_of(&run, expected), "ada", "type {kind:?}");
    }
}

#[test]
fn ignores_fields_of_other_types_and_fields_after_the_password() {
    let run = run(
        &fill_script("ada", "pw"),
        json!([
            {"type": "checkbox"},
            {"type": "number"},
            {"type": "password"},
            {"type": "text"}
        ]),
    );
    assert_eq!(run.result, json!({"filled": true, "user": false}));
    assert_eq!(value_of(&run, 0), "");
    assert_eq!(value_of(&run, 1), "");
    assert_eq!(value_of(&run, 2), "pw");
    assert_eq!(value_of(&run, 3), "");
}

#[test]
fn ignores_a_username_field_that_is_not_visible() {
    let run = run(
        &fill_script("ada", "pw"),
        json!([
            {"type": "text", "visible": false},
            {"type": "text", "hidden": true},
            {"type": "password"}
        ]),
    );
    assert_eq!(run.result, json!({"filled": true, "user": false}));
    assert_eq!(value_of(&run, 0), "");
    assert_eq!(value_of(&run, 1), "");
}

#[test]
fn fills_only_the_password_and_reports_no_user_when_the_form_has_no_username_field() {
    let run = run(&fill_script("ada", "pw"), json!([{"type": "password"}]));
    assert_eq!(run.result, json!({"filled": true, "user": false}));
    assert_eq!(value_of(&run, 0), "pw");
}

#[test]
fn leaves_the_username_field_alone_when_the_username_is_empty() {
    let run = run(
        &fill_script("", "pw"),
        json!([{"type": "text", "value": "kept"}, {"type": "password"}]),
    );
    assert_eq!(run.result, json!({"filled": true, "user": true}));
    assert_eq!(value_of(&run, 0), "kept");
    assert_eq!(events_of(&run, 0), Vec::<&str>::new());
    assert_eq!(value_of(&run, 1), "pw");
}

#[test]
fn looks_for_the_username_only_inside_the_form_of_the_password() {
    let run = run(
        &fill_script("ada", "pw"),
        json!([
            {"type": "text"},
            {"type": "text", "form": "other"},
            {"type": "text", "form": "login"},
            {"type": "password", "form": "login"}
        ]),
    );
    assert_eq!(value_of(&run, 0), "");
    assert_eq!(value_of(&run, 1), "");
    assert_eq!(value_of(&run, 2), "ada");
    assert_eq!(value_of(&run, 3), "pw");
}

#[test]
fn looks_in_the_whole_page_when_the_password_has_no_form() {
    let run = run(
        &fill_script("ada", "pw"),
        json!([
            {"type": "text", "form": "other"},
            {"type": "password"}
        ]),
    );
    assert_eq!(run.result, json!({"filled": true, "user": true}));
    assert_eq!(value_of(&run, 0), "ada");
}

#[test]
fn fills_the_first_visible_password_field_only() {
    let run = run(
        &fill_script("ada", "pw"),
        json!([{"type": "password"}, {"type": "password"}]),
    );
    assert_eq!(value_of(&run, 0), "pw");
    assert_eq!(value_of(&run, 1), "");
}

#[test]
fn writes_quotes_line_breaks_and_script_text_in_the_values_as_plain_text() {
    let username = "a\"b'c\\d\ne\u{2028}f`${x}";
    let password = "p</script>\"';\u{2029}\r\n\\u0041${1+1}";
    let run = run(
        &fill_script(username, password),
        json!([{"type": "text"}, {"type": "password"}]),
    );
    assert_eq!(value_of(&run, 0), username);
    assert_eq!(value_of(&run, 1), password);
}

#[test]
fn builds_a_script_that_runs_at_once_and_takes_no_arguments() {
    for script in [fill_script("a", "b"), read_script()] {
        assert!(script.starts_with("(() => {"), "{script}");
        assert!(script.ends_with("})()"), "{script}");
    }
}

#[test]
fn does_not_put_the_username_or_password_in_the_read_script() {
    let script = read_script();
    assert!(!script.contains("ada"));
    assert!(!script.contains("s3cret"));
}

#[test]
fn reads_the_username_and_the_password_the_person_typed() {
    let run = run(
        &read_script(),
        json!([{"type": "text", "value": "ada"}, {"type": "password", "value": "s3cret"}]),
    );
    assert_eq!(run.result, json!({"username": "ada", "password": "s3cret"}));
}

#[test]
fn reads_nothing_when_there_is_no_password_field_or_it_is_empty() {
    let none = run(&read_script(), json!([{"type": "text", "value": "ada"}]));
    assert_eq!(none.result, Value::Null);
    let empty = run(
        &read_script(),
        json!([{"type": "text", "value": "ada"}, {"type": "password", "value": ""}]),
    );
    assert_eq!(empty.result, Value::Null);
}

#[test]
fn reads_an_empty_username_when_the_page_has_no_username_field() {
    let run = run(
        &read_script(),
        json!([{"type": "password", "value": "s3cret"}]),
    );
    assert_eq!(run.result, json!({"username": "", "password": "s3cret"}));
}

#[test]
fn reads_without_changing_a_field_or_firing_an_event() {
    let run = run(
        &read_script(),
        json!([{"type": "text", "value": "ada"}, {"type": "password", "value": "pw"}]),
    );
    for index in 0..2 {
        assert_eq!(events_of(&run, index), Vec::<&str>::new());
        assert_eq!(run.inputs[index]["focused"], json!(false));
    }
}

#[test]
fn reads_the_username_with_the_same_field_choice_as_the_fill_script() {
    let run = run(
        &read_script(),
        json!([
            {"type": "text", "autocomplete": "username", "value": "by-autocomplete"},
            {"type": "text", "value": "nearest"},
            {"type": "password", "value": "pw"}
        ]),
    );
    assert_eq!(run.result["username"], json!("by-autocomplete"));
}
