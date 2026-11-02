#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_diagnostics::session_facts::{
    ExtensionState, SessionFactsDeps, WindowFacts, create_session_facts,
};
use serde_json::{Value, json};

fn deps(settings: Value) -> SessionFactsDeps {
    SessionFactsDeps {
        read_settings: Arc::new(move || settings.clone()),
        installed_extensions: Arc::new(Vec::new),
        extensions: Arc::new(Vec::new),
        windows: Arc::new(Vec::new),
        restore_outcome: Arc::new(|| "ok".to_owned()),
    }
}

fn in_effect(deps: SessionFactsDeps) -> Vec<(String, Vec<(String, String)>)> {
    create_session_facts(deps)().in_effect
}

fn pair(key: &str, value: &str) -> (String, String) {
    (key.to_owned(), value.to_owned())
}

#[test]
fn falls_back_to_terminal_input_mode_shell_prompt_and_gpu_on_when_settings_hold_nothing() {
    assert_eq!(
        in_effect(deps(json!({}))),
        [
            (
                "features".to_owned(),
                vec![
                    pair("input_mode", "terminal"),
                    pair("prompt_style", "shell")
                ]
            ),
            ("terminal".to_owned(), vec![pair("gpu", "on")]),
        ]
    );
    assert_eq!(in_effect(deps(Value::Null)), in_effect(deps(json!({}))));
}

#[test]
fn reads_the_input_mode_and_prompt_style_when_they_are_strings_and_falls_back_for_other_types() {
    let set = in_effect(deps(
        json!({"behavior": {"inputMode": "editor"}, "terminal": {"prompt": {"style": "pill"}}}),
    ));
    assert_eq!(
        set[0].1,
        [pair("input_mode", "editor"), pair("prompt_style", "pill")]
    );
    let odd = in_effect(deps(
        json!({"behavior": {"inputMode": 3}, "terminal": {"prompt": {"style": null}}}),
    ));
    assert_eq!(
        odd[0].1,
        [
            pair("input_mode", "terminal"),
            pair("prompt_style", "shell")
        ]
    );
}

#[test]
fn reports_gpu_off_only_when_gpu_acceleration_is_exactly_false() {
    let gpu = |settings: Value| in_effect(deps(settings))[1].1.clone();
    assert_eq!(
        gpu(json!({"behavior": {"gpuAcceleration": false}})),
        [pair("gpu", "off")]
    );
    assert_eq!(
        gpu(json!({"behavior": {"gpuAcceleration": true}})),
        [pair("gpu", "on")]
    );
    assert_eq!(
        gpu(json!({"behavior": {"gpuAcceleration": 0}})),
        [pair("gpu", "on")]
    );
    assert_eq!(
        gpu(json!({"behavior": {"gpuAcceleration": "false"}})),
        [pair("gpu", "on")]
    );
}

#[test]
fn buckets_the_window_count_and_counts_workspaces_of_live_windows_only() {
    let mut set = deps(json!({}));
    set.windows = Arc::new(|| {
        vec![
            WindowFacts {
                destroyed: false,
                workspaces: 2,
            },
            WindowFacts {
                destroyed: true,
                workspaces: 5,
            },
            WindowFacts {
                destroyed: false,
                workspaces: 3,
            },
        ]
    });
    let facts = create_session_facts(set)();
    assert_eq!(facts.windows, "2-3");
    assert_eq!(facts.workspaces, "4-7");
}

#[test]
fn reports_zero_windows_and_zero_workspaces_when_there_is_no_window() {
    let facts = create_session_facts(deps(json!({})))();
    assert_eq!(facts.windows, "0");
    assert_eq!(facts.workspaces, "0");
}

#[test]
fn lists_an_extension_as_enabled_only_when_it_is_also_installed() {
    let mut set = deps(json!({}));
    set.installed_extensions = Arc::new(|| vec!["a".to_owned(), "b".to_owned()]);
    set.extensions = Arc::new(|| {
        vec![
            ExtensionState {
                id: "a".to_owned(),
                enabled: true,
            },
            ExtensionState {
                id: "b".to_owned(),
                enabled: false,
            },
            ExtensionState {
                id: "c".to_owned(),
                enabled: true,
            },
        ]
    });
    let facts = create_session_facts(set)();
    assert_eq!(facts.installed_extensions, ["a", "b"]);
    assert_eq!(facts.enabled_extensions, ["a"]);
}

#[test]
fn passes_the_restore_outcome_through() {
    let mut set = deps(json!({}));
    set.restore_outcome = Arc::new(|| "fallback".to_owned());
    assert_eq!(create_session_facts(set)().restore, "fallback");
}
