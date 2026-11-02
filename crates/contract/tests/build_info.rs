#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::build_info::{
    BuildInfo, TelemetryStamp, is_dirty_build, parse_build_info, parse_telemetry_stamp,
    release_version, same_build,
};
use ostia_contract::releases::is_newer_version;
use serde_json::json;

fn info(version: &str, built_at: &str) -> BuildInfo {
    BuildInfo {
        version: version.to_owned(),
        built_at: built_at.to_owned(),
        telemetry: None,
        server: None,
    }
}

#[test]
fn drops_the_build_metadata_so_a_local_build_is_not_offered_its_own_release() {
    assert_eq!(release_version("0.5.9+sha.1a2b3c.dirty"), "0.5.9");
    assert_eq!(release_version("0.5.9-rc.3+sha.1a2b3c"), "0.5.9-rc.3");
    assert_eq!(release_version("0.5.9"), "0.5.9");
    assert!(!is_newer_version(
        "0.5.9",
        release_version("0.5.9+sha.1a2b3c")
    ));
}

#[test]
fn keeps_the_version_and_build_time_and_refuses_anything_else() {
    assert_eq!(
        parse_build_info(
            &json!({"version": "0.5.9+sha.1a2b3c", "builtAt": "2026-10-06T00:00:00Z", "x": 1})
        ),
        Some(info("0.5.9+sha.1a2b3c", "2026-10-06T00:00:00Z"))
    );
    assert_eq!(parse_build_info(&json!({"version": "0.5.9"})), None);
    assert_eq!(parse_build_info(&json!(null)), None);
}

#[test]
fn is_read_back_from_the_stamp_only_when_complete_and_never_invented() {
    assert_eq!(
        parse_build_info(&json!({
            "version": "1.0.0",
            "builtAt": "t",
            "telemetry": {"key": "phc_x", "host": "https://h"}
        })),
        Some(BuildInfo {
            telemetry: Some(TelemetryStamp {
                key: "phc_x".to_owned(),
                host: "https://h".to_owned()
            }),
            ..info("1.0.0", "t")
        })
    );
    assert_eq!(
        parse_build_info(&json!({
            "version": "1.0.0",
            "builtAt": "t",
            "telemetry": {"key": "phc_x"}
        })),
        Some(info("1.0.0", "t"))
    );
    assert_eq!(
        parse_build_info(&json!({"version": "1.0.0", "builtAt": "t"})),
        Some(info("1.0.0", "t"))
    );
    assert_eq!(
        parse_telemetry_stamp(&json!({"key": "", "host": "https://h"})),
        None
    );
    assert_eq!(parse_telemetry_stamp(&json!("x")), None);
}

#[test]
fn is_true_only_for_a_version_ending_with_dirty() {
    assert!(is_dirty_build("0.5.13-rc.2+sha.b7a0e3.dirty"));
    assert!(!is_dirty_build("0.5.13-rc.2+sha.b7a0e3"));
    assert!(!is_dirty_build("0.5.13"));
    assert!(!is_dirty_build(""));
}

#[test]
fn keeps_a_server_only_when_it_is_a_non_empty_string_new_case() {
    let parsed = |server: serde_json::Value| {
        parse_build_info(&json!({"version": "1.0.0", "builtAt": "t", "server": server}))
            .unwrap()
            .server
    };
    assert_eq!(parsed(json!("https://s")), Some("https://s".to_owned()));
    assert_eq!(parsed(json!("")), None);
    assert_eq!(parsed(json!(3)), None);
}

#[test]
fn compares_builds_by_version_and_build_time_only_new_case() {
    let a = info("1.0.0", "t");
    assert!(same_build(
        &a,
        &BuildInfo {
            server: Some("s".to_owned()),
            ..info("1.0.0", "t")
        }
    ));
    assert!(!same_build(&a, &info("1.0.1", "t")));
    assert!(!same_build(&a, &info("1.0.0", "u")));
}
