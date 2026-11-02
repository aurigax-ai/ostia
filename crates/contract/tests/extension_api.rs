#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::extension_api::{
    ApiVersion, EXTENSION_API_VERSION, api_problem, is_api_compatible, parse_api_version,
};
use serde_json::{Value, json};

fn version(major: u32, minor: u32) -> ApiVersion {
    ApiVersion { major, minor }
}

#[test]
fn reads_major_minor_and_refuses_anything_else() {
    assert_eq!(parse_api_version(&json!("1.0")), Some(version(1, 0)));
    assert_eq!(parse_api_version(&json!("12.34")), Some(version(12, 34)));
    let bad = [
        json!("1"),
        json!("1.0.0"),
        json!("v1.0"),
        json!("01.0"),
        json!("1.x"),
        json!(""),
        json!(1),
        Value::Null,
    ];
    for value in bad {
        assert_eq!(parse_api_version(&value), None, "{value}");
    }
}

#[test]
fn accepts_the_same_major_with_an_equal_or_older_minor() {
    let provided = version(2, 3);
    assert!(is_api_compatible(&version(2, 3), &provided));
    assert!(is_api_compatible(&version(2, 0), &provided));
}

#[test]
fn refuses_a_newer_minor_and_any_other_major() {
    let provided = version(2, 3);
    assert!(!is_api_compatible(&version(2, 4), &provided));
    assert!(!is_api_compatible(&version(1, 9), &provided));
    assert!(!is_api_compatible(&version(3, 0), &provided));
}

#[test]
fn says_nothing_for_a_version_the_app_provides() {
    assert_eq!(api_problem(&json!(EXTENSION_API_VERSION), None), None);
    assert_eq!(api_problem(&json!("2.1"), Some("2.3")), None);
}

#[test]
fn names_both_versions_when_they_do_not_fit() {
    assert_eq!(
        api_problem(&json!("2.4"), Some("2.3")).as_deref(),
        Some("needs extension API 2.4; this ostia provides 2.3")
    );
    assert_eq!(
        api_problem(&json!("1.0"), Some("2.3")).as_deref(),
        Some("needs extension API 1.0; this ostia provides 2.3")
    );
    assert_eq!(
        api_problem(&json!("soon"), Some("2.3")).as_deref(),
        Some("api must be an extension API version such as 1.0")
    );
}

#[test]
fn reports_a_provided_version_that_does_not_parse_as_not_fitting() {
    assert_eq!(
        api_problem(&json!("1.0"), Some("garbage")).as_deref(),
        Some("needs extension API 1.0; this ostia provides garbage")
    );
}

#[test]
fn refuses_a_required_value_that_is_not_a_string_before_it_reads_the_provided_one() {
    assert_eq!(
        api_problem(&json!(1), Some("garbage")).as_deref(),
        Some("api must be an extension API version such as 1.0")
    );
    assert_eq!(
        api_problem(&Value::Null, None).as_deref(),
        Some("api must be an extension API version such as 1.0")
    );
}

#[test]
fn defaults_the_provided_version_to_the_app_version() {
    let newer = format!(
        "{}.0",
        parse_api_version(&json!(EXTENSION_API_VERSION))
            .unwrap()
            .major
            + 1
    );
    assert_eq!(
        api_problem(&json!(newer), None),
        Some(format!(
            "needs extension API {newer}; this ostia provides {EXTENSION_API_VERSION}"
        ))
    );
}
