use std::sync::LazyLock;

use ostia_base::ExternalId;
use ostia_base::js::{js_trim, static_regex};
use ostia_contract::script_tokens::{ScriptTokenCallOutcome, ScriptTokenCallTarget};
use regex::Regex;
use serde_json::Value;

use crate::identity::{IdRegistry, IdentityKind};

static METHOD_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z0-9_.-]{1,80}$"));
static WORKSPACE_REF: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9_.:@-]{1,100}$"));
static ERROR_CODE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^([a-z][a-z0-9-]{0,40})(?::|$)"));
static CAP_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][a-z-]{0,40}$"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallOutcome {
    pub outcome: ScriptTokenCallOutcome,
    pub code: Option<String>,
}

fn field<'a>(raw: &'a Value, name: &str) -> Option<&'a Value> {
    raw.as_object()?.get(name)
}

pub fn called_method(name: &str, params: &Value) -> String {
    if name != "command.exec" {
        return name.to_owned();
    }
    match field(params, "id").and_then(Value::as_str) {
        Some(id) if METHOD_NAME.is_match(id) => id.to_owned(),
        _ => name.to_owned(),
    }
}

pub fn called_target(registry: &IdRegistry, params: &Value) -> ScriptTokenCallTarget {
    let args = field(params, "args");
    let pane_ref = [
        field(params, "pane"),
        field(params, "paneId"),
        args.and_then(|args| field(args, "paneId")),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str);
    if let Some(pane) = pane_ref
        .and_then(|given| registry.resolve_external(&ExternalId::new(given)))
        .filter(|identity| identity.kind == IdentityKind::Pane)
    {
        return ScriptTokenCallTarget {
            workspace_id: Some(pane.workspace_id.as_str().to_owned()),
            pane_id: Some(pane.external_id.as_str().to_owned()),
        };
    }
    let workspace = [
        field(params, "target").and_then(|target| field(target, "workspaceId")),
        field(params, "workspace"),
        field(params, "workspaceId"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find(|value| WORKSPACE_REF.is_match(value));
    ScriptTokenCallTarget {
        workspace_id: workspace.map(str::to_owned),
        pane_id: None,
    }
}

fn code_of(message: &str) -> &str {
    ERROR_CODE
        .captures(message)
        .and_then(|captures| captures.get(1))
        .map_or("error", |code| code.as_str())
}

pub fn result_outcome(result: &Value) -> CallOutcome {
    if field(result, "ok") != Some(&Value::Bool(false)) {
        return CallOutcome {
            outcome: ScriptTokenCallOutcome::Ok,
            code: None,
        };
    }
    let code = field(result, "error")
        .and_then(|error| field(error, "code"))
        .and_then(Value::as_str)
        .map_or("error", code_of);
    CallOutcome {
        outcome: ScriptTokenCallOutcome::Error,
        code: Some(code.to_owned()),
    }
}

pub fn error_outcome(message: &str) -> Option<CallOutcome> {
    if message == "unknown identity" {
        return None;
    }
    let code = code_of(message);
    if code != "needs-elevation" {
        return Some(CallOutcome {
            outcome: ScriptTokenCallOutcome::Error,
            code: Some(code.to_owned()),
        });
    }
    let cap = js_trim(message.get(code.len() + 1..).unwrap_or(""));
    if !CAP_NAME.is_match(cap) {
        return Some(CallOutcome {
            outcome: ScriptTokenCallOutcome::MissingPermission,
            code: Some(code.to_owned()),
        });
    }
    let outcome = if cap == "all-workspaces" {
        ScriptTokenCallOutcome::OutOfScope
    } else {
        ScriptTokenCallOutcome::MissingPermission
    };
    Some(CallOutcome {
        outcome,
        code: Some(format!("{code}: {cap}")),
    })
}
