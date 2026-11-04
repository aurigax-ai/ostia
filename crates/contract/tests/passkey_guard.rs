#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use ostia_contract::passkey_guard::{PASSKEY_GUARD_JS, PASSKEY_NOTICE_PREFIX};
use serde_json::{Value, json};

struct Page {
    steps: Vec<Value>,
    calls: Vec<String>,
    info: Vec<String>,
    keys: Vec<String>,
}

fn harness() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/browser/passkeyHarness.mjs")
}

fn run(scenario: Value) -> Page {
    let mut input = scenario;
    input["script"] = json!(PASSKEY_GUARD_JS);
    let mut child = Command::new("node")
        .arg(harness())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let strings = |key: &str| -> Vec<String> {
        report[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_owned())
            .collect()
    };
    Page {
        steps: report["steps"].as_array().unwrap().clone(),
        calls: strings("calls"),
        info: strings("info"),
        keys: strings("publicKeyCredentialKeys"),
    }
}

fn allow(transports: Value) -> Value {
    let mut credential = json!({"id": [0, 0, 0, 0], "type": "public-key"});
    if !transports.is_null() {
        credential["transports"] = transports;
    }
    json!({"publicKey": {"allowCredentials": [credential]}})
}

fn call(name: &str, args: Vec<Value>) -> Value {
    json!({"call": name, "args": args})
}

fn refused(step: &Value) -> bool {
    step["ok"] == json!(false) && step["name"] == json!("NotAllowedError")
}

fn passed(step: &Value, value: &str) -> bool {
    step["ok"] == json!(true) && step["value"] == json!(value)
}

#[test]
fn rejects_at_once_with_not_allowed_error_when_the_credential_is_internal_only_hybrid_only_or_both()
{
    let table = [
        ("internal only", json!(["internal"])),
        ("hybrid only", json!(["hybrid"])),
        ("internal and hybrid", json!(["internal", "hybrid"])),
    ];
    for (name, transports) in table {
        let page = run(json!({"steps": [call("get", vec![allow(transports)])]}));
        assert!(refused(&page.steps[0]), "{name}");
        assert_eq!(page.calls, Vec::<String>::new(), "{name}");
    }
}

#[test]
fn passes_the_request_through_when_the_credential_lists_a_transport_that_can_leave_the_device() {
    let table = [
        ("usb", json!(["usb"])),
        ("nfc", json!(["nfc"])),
        ("ble", json!(["ble"])),
        ("usb with hybrid", json!(["hybrid", "usb"])),
        ("no transports", Value::Null),
        ("empty transports", json!([])),
    ];
    for (name, transports) in table {
        let page = run(json!({"steps": [call("get", vec![allow(transports)])]}));
        assert!(passed(&page.steps[0], "got"), "{name}");
        assert_eq!(page.calls.len(), 1, "{name}");
    }
}

#[test]
fn passes_through_when_any_one_credential_could_be_a_security_key() {
    let options = json!({"publicKey": {"allowCredentials": [
        {"id": [0, 0, 0, 0], "type": "public-key", "transports": ["internal"]},
        {"id": [0, 0, 0, 0], "type": "public-key", "transports": ["usb"]}
    ]}});
    let page = run(json!({"steps": [call("get", vec![options])]}));
    assert!(passed(&page.steps[0], "got"));
    assert_eq!(page.calls.len(), 1);
}

#[test]
fn passes_through_discoverable_requests_conditional_mediation_and_non_public_key_requests() {
    let mut conditional = allow(json!(["internal"]));
    conditional["mediation"] = json!("conditional");
    let page = run(json!({"steps": [
        call("get", vec![json!({"publicKey": {"challenge": [0, 0, 0, 0]}})]),
        call("get", vec![conditional]),
        call("get", vec![json!({"password": true})]),
        call("get", vec![]),
    ]}));
    for step in &page.steps {
        assert!(passed(step, "got"), "{step}");
    }
    assert_eq!(page.calls.len(), 4);
}

#[test]
fn rejects_at_once_with_not_allowed_error_for_a_platform_only_authenticator() {
    let options =
        json!({"publicKey": {"authenticatorSelection": {"authenticatorAttachment": "platform"}}});
    let page = run(json!({"steps": [call("create", vec![options])]}));
    assert!(refused(&page.steps[0]));
    assert_eq!(page.calls, Vec::<String>::new());
}

#[test]
fn passes_the_create_request_through_when_it_is_cross_platform_unrestricted_or_has_no_selection() {
    let table = [
        (
            "cross-platform",
            json!({"authenticatorSelection": {"authenticatorAttachment": "cross-platform"}}),
        ),
        (
            "unrestricted",
            json!({"authenticatorSelection": {"userVerification": "preferred"}}),
        ),
        ("no selection", json!({})),
    ];
    for (name, public_key) in table {
        let page = run(json!({"steps": [call("create", vec![json!({"publicKey": public_key})])]}));
        assert!(passed(&page.steps[0], "created"), "{name}");
        assert_eq!(page.calls.len(), 1, "{name}");
    }
}

#[test]
fn passes_a_create_request_through_that_has_no_public_key_or_no_options() {
    let page = run(json!({"steps": [
        call("create", vec![json!({"password": {"id": "a"}})]),
        call("create", vec![]),
    ]}));
    assert!(passed(&page.steps[0], "created"));
    assert!(passed(&page.steps[1], "created"));
    assert_eq!(page.calls, ["create", "create"]);
}

#[test]
fn logs_the_notice_once_per_page_however_many_requests_are_refused() {
    let page = run(json!({"steps": [
        call("get", vec![allow(json!(["internal"]))]),
        call("get", vec![allow(json!(["hybrid"]))]),
    ]}));
    assert_eq!(page.info, [PASSKEY_NOTICE_PREFIX]);
}

#[test]
fn stays_silent_when_the_request_is_passed_through() {
    let page = run(json!({"steps": [call("get", vec![allow(json!(["usb"]))])]}));
    assert_eq!(page.info, Vec::<String>::new());
}

#[test]
fn names_the_notice_prefix_the_page_log_carries() {
    assert_eq!(PASSKEY_NOTICE_PREFIX, "[ostia-passkey-unsupported]");
}

#[test]
fn counts_a_refused_create_and_a_refused_get_as_one_notice() {
    let page = run(json!({"steps": [
        call("create", vec![json!({"publicKey": {"authenticatorSelection": {"authenticatorAttachment": "platform"}}})]),
        call("get", vec![allow(json!(["internal"]))]),
    ]}));
    assert_eq!(page.info.len(), 1);
}

#[test]
fn says_in_the_error_message_that_passkeys_are_not_supported() {
    let page = run(json!({"steps": [call("get", vec![allow(json!(["internal"]))])]}));
    assert_eq!(
        page.steps[0]["message"],
        json!("Passkeys are not supported in this browser.")
    );
}

#[test]
fn stops_claiming_passkey_hybrid_and_platform_verifier_support() {
    let page = run(json!({
        "capabilities": {
            "passkeyPlatformAuthenticator": true,
            "hybridTransport": true,
            "userVerifyingPlatformAuthenticator": true,
            "conditionalGet": true
        },
        "steps": [{"call": "capabilities"}]
    }));
    assert_eq!(
        page.steps[0]["value"],
        json!({
            "passkeyPlatformAuthenticator": false,
            "hybridTransport": false,
            "userVerifyingPlatformAuthenticator": false,
            "conditionalGet": true
        })
    );
}

#[test]
fn adds_the_three_capability_flags_as_false_when_the_page_did_not_list_them() {
    let page = run(json!({
        "capabilities": {"conditionalGet": true},
        "steps": [{"call": "capabilities"}]
    }));
    assert_eq!(
        page.steps[0]["value"],
        json!({
            "conditionalGet": true,
            "passkeyPlatformAuthenticator": false,
            "hybridTransport": false,
            "userVerifyingPlatformAuthenticator": false
        })
    );
}

#[test]
fn does_nothing_when_the_page_has_no_get_client_capabilities() {
    let page = run(json!({"steps": []}));
    assert_eq!(page.keys, Vec::<String>::new());
}

#[test]
fn resolves_false_even_when_the_engine_would_say_true() {
    let page = run(json!({"uvpaa": true, "steps": [{"call": "uvpaa"}]}));
    assert_eq!(page.steps[0]["value"], json!(false));
}

#[test]
fn wraps_once_even_when_the_script_runs_twice_in_the_same_page() {
    let page = run(json!({"steps": [
        {"call": "rerun"},
        call("get", vec![allow(json!(["usb"]))]),
    ]}));
    assert!(passed(&page.steps[1], "got"));
    assert_eq!(page.calls.len(), 1);
}

#[test]
fn runs_without_error_when_the_page_has_no_credentials_object() {
    let page = run(json!({"noCredentials": true, "steps": []}));
    assert_eq!(page.steps, Vec::<Value>::new());
}

#[test]
fn leaves_the_capability_and_verifier_checks_alone_when_the_page_lacks_them() {
    let page = run(json!({"steps": []}));
    assert_eq!(page.keys, Vec::<String>::new());
    let page = run(json!({"uvpaa": false, "steps": []}));
    assert_eq!(page.keys, ["isUserVerifyingPlatformAuthenticatorAvailable"]);
}
