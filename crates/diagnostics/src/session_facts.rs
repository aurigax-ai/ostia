use std::sync::Arc;

use serde_json::Value;

use crate::privacy_telemetry::bucket_count;
use crate::telemetry_usage::SessionFacts;

#[derive(Debug, Clone)]
pub struct ExtensionState {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct WindowFacts {
    pub destroyed: bool,
    pub workspaces: usize,
}

pub struct SessionFactsDeps {
    pub read_settings: Arc<dyn Fn() -> Value + Send + Sync>,
    pub installed_extensions: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    pub extensions: Arc<dyn Fn() -> Vec<ExtensionState> + Send + Sync>,
    pub windows: Arc<dyn Fn() -> Vec<WindowFacts> + Send + Sync>,
    pub restore_outcome: Arc<dyn Fn() -> String + Send + Sync>,
}

fn text(value: Option<&Value>, fallback: &str) -> String {
    value.and_then(Value::as_str).unwrap_or(fallback).to_owned()
}

pub fn create_session_facts(deps: SessionFactsDeps) -> impl Fn() -> SessionFacts + Send + Sync {
    move || {
        let settings = (deps.read_settings)();
        let behavior = settings.get("behavior");
        let terminal = settings.get("terminal");
        let installed = (deps.installed_extensions)();
        let enabled: Vec<String> = (deps.extensions)()
            .into_iter()
            .filter(|ext| ext.enabled && installed.contains(&ext.id))
            .map(|ext| ext.id)
            .collect();
        let windows = (deps.windows)();
        let workspaces: usize = windows
            .iter()
            .filter(|window| !window.destroyed)
            .map(|window| window.workspaces)
            .sum();
        let gpu_off = behavior
            .and_then(|behavior| behavior.get("gpuAcceleration"))
            .is_some_and(|value| *value == Value::Bool(false));
        SessionFacts {
            windows: bucket_count(windows.len()).to_owned(),
            workspaces: bucket_count(workspaces).to_owned(),
            restore: (deps.restore_outcome)(),
            in_effect: vec![
                (
                    "features".to_owned(),
                    vec![
                        (
                            "input_mode".to_owned(),
                            text(behavior.and_then(|b| b.get("inputMode")), "terminal"),
                        ),
                        (
                            "prompt_style".to_owned(),
                            text(
                                terminal
                                    .and_then(|t| t.get("prompt"))
                                    .and_then(|p| p.get("style")),
                                "shell",
                            ),
                        ),
                    ],
                ),
                (
                    "terminal".to_owned(),
                    vec![(
                        "gpu".to_owned(),
                        if gpu_off { "off" } else { "on" }.to_owned(),
                    )],
                ),
            ],
            installed_extensions: installed,
            enabled_extensions: enabled,
        }
    }
}
