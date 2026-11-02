use ostia_base::ExternalId;
use serde_json::Value;

use crate::identity::{IdRegistry, IdentityKind, PaneIdentity};

pub const SCRIPT_COMMANDS: &[&str] = &[
    "workspace.new",
    "pane.close",
    "workspace.close",
    "workspace.group",
    "workspace.groupColor",
    "workspace.groupRename",
    "workspace.groupDelete",
    "workspace.pin",
    "workspace.unpin",
    "workspace.ungroup",
    "workspace.newScratch",
];

pub type PaneArgs = Result<(Value, Option<PaneIdentity>), String>;

pub fn internal_pane_args(registry: &IdRegistry, args: &Value) -> PaneArgs {
    let Some(object) = args.as_object() else {
        return Ok((args.clone(), None));
    };
    let Some(given) = object.get("paneId").and_then(Value::as_str) else {
        return Ok((args.clone(), None));
    };
    let pane = registry
        .resolve_external(&ExternalId::new(given))
        .filter(|identity| identity.kind == IdentityKind::Pane)
        .ok_or_else(|| format!("unknown-pane: {given} (use a paneId from ostia pane list)"))?;
    let mut swapped = object.clone();
    swapped.insert(
        "paneId".to_owned(),
        Value::String(pane.pane_id.as_str().to_owned()),
    );
    Ok((Value::Object(swapped), Some(pane)))
}

pub fn external_pane_message(message: &str, pane: Option<&PaneIdentity>) -> String {
    match pane {
        Some(pane) => message.replace(pane.pane_id.as_str(), pane.external_id.as_str()),
        None => message.to_owned(),
    }
}
