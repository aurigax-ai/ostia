use std::sync::LazyLock;

use ostia_base::clock::now_ms;
use ostia_base::js::{js_trim, static_regex, utf16_len};
use ostia_contract::capabilities::Capability;
use ostia_contract::script_tokens::{
    DEFAULT_TOKEN_EXPIRY, NEVER_EXPIRES, SCRIPT_CAPABILITIES, ScriptTokenScope, token_expiry,
};
use ostia_rpc::RpcError;
use regex::Regex;
use serde_json::Value;

const NAME_MAX: usize = 60;
const SCOPE_MISSING: &str =
    "bad-request: scope (pass --scope all, group:<name|id> or workspace:<name|id>)";
const SCOPE_EMPTY: &str = "bad-request: scope (all, or at least one group or workspace)";

static NAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z0-9_ .@-]+$"));
static NULL: Value = Value::Null;

pub fn fail(message: impl Into<String>) -> RpcError {
    RpcError::invalid_request(message)
}

fn named(item: &Value) -> Option<Capability> {
    let name = item.as_str()?;
    SCRIPT_CAPABILITIES
        .iter()
        .copied()
        .find(|cap| cap.name() == name)
}

fn script_order(caps: &[Value]) -> Vec<Capability> {
    SCRIPT_CAPABILITIES
        .iter()
        .copied()
        .filter(|cap| caps.iter().any(|item| item.as_str() == Some(cap.name())))
        .collect()
}

fn held_from(caps: &[Capability]) -> Vec<Capability> {
    SCRIPT_CAPABILITIES
        .iter()
        .copied()
        .filter(|cap| *cap != Capability::AllWorkspaces && caps.contains(cap))
        .collect()
}

pub fn held_caps(raw: &Value) -> Vec<Capability> {
    let held: Vec<Capability> = raw
        .as_array()
        .map(|items| items.iter().filter_map(named).collect())
        .unwrap_or_default();
    held_from(&held)
}

pub fn ids(raw: &Value) -> Option<Vec<String>> {
    let items = raw.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let id = item.as_str().filter(|id| !id.is_empty())?;
        if !out.iter().any(|seen| seen == id) {
            out.push(id.to_owned());
        }
    }
    Some(out)
}

fn clean_token_name(raw: Option<&Value>) -> Result<String, RpcError> {
    let name = raw.and_then(Value::as_str).map_or("", js_trim);
    if name.is_empty() || utf16_len(name) > NAME_MAX || !NAME_PATTERN.is_match(name) {
        return Err(fail(format!(
            "bad-request: name (1-{NAME_MAX} letters, digits, space, . _ @ -)"
        )));
    }
    Ok(name.to_owned())
}

fn js_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_text).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn clean_caps(raw: &Value) -> Result<Vec<Capability>, RpcError> {
    let items = raw
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| fail("bad-request: caps"))?;
    let unknown: Vec<String> = items
        .iter()
        .filter(|item| named(item).is_none())
        .map(js_text)
        .collect();
    if !unknown.is_empty() {
        let allowed: Vec<&str> = SCRIPT_CAPABILITIES.iter().map(|cap| cap.name()).collect();
        return Err(fail(format!(
            "bad-request: a script token can hold only {} (got {})",
            allowed.join(", "),
            unknown.join(", ")
        )));
    }
    Ok(script_order(items))
}

fn clean_expires(raw: &Value, confirm_never: Option<&Value>) -> Result<String, RpcError> {
    let text = raw
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| fail("bad-request: expires"))?;
    if text == NEVER_EXPIRES && confirm_never.and_then(Value::as_bool) != Some(true) {
        return Err(fail(
            "bad-request: expires never needs confirmNeverExpires: true",
        ));
    }
    token_expiry(text, now_ms()).map_err(|message| fail(format!("bad-request: {message}")))?;
    Ok(text.to_owned())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScopeRequest {
    All,
    Limited {
        groups: Vec<String>,
        workspaces: Vec<String>,
        own_workspaces: bool,
    },
}

fn clean_scope(raw: Option<&Value>, caps: &[Capability]) -> Result<Option<ScopeRequest>, RpcError> {
    let reach_all = caps.contains(&Capability::AllWorkspaces);
    let Some(raw) = raw else {
        return Ok(reach_all.then_some(ScopeRequest::All));
    };
    let kind = raw.get("kind").and_then(Value::as_str);
    if kind == Some("all") {
        return Ok(Some(ScopeRequest::All));
    }
    let list = |key: &str| match raw.get(key) {
        None => Some(Vec::new()),
        Some(value) => ids(value),
    };
    let (Some(groups), Some(workspaces)) = (list("groups"), list("workspaces")) else {
        return Err(fail(SCOPE_EMPTY));
    };
    if kind != Some("limited") || groups.len() + workspaces.len() == 0 {
        return Err(fail(SCOPE_EMPTY));
    }
    if reach_all {
        return Err(fail("bad-request: all-workspaces needs the scope all"));
    }
    Ok(Some(ScopeRequest::Limited {
        groups,
        workspaces,
        own_workspaces: raw.get("ownWorkspaces").and_then(Value::as_bool) == Some(true),
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenRequest {
    pub name: String,
    pub caps: Vec<Capability>,
    pub scope: ScopeRequest,
    pub expires: String,
}

pub fn parse_token_request(raw: &Value) -> Result<TokenRequest, RpcError> {
    let name = clean_token_name(raw.get("name"))?;
    let caps = clean_caps(raw.get("caps").unwrap_or(&NULL))?;
    let scope = clean_scope(raw.get("scope"), &caps)?.ok_or_else(|| fail(SCOPE_MISSING))?;
    let expires = match raw.get("expires") {
        None => DEFAULT_TOKEN_EXPIRY.to_owned(),
        Some(value) => clean_expires(value, raw.get("confirmNeverExpires"))?,
    };
    Ok(TokenRequest {
        name,
        caps: held_from(&caps),
        scope,
        expires,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenChanges {
    pub reference: String,
    pub name: Option<String>,
    pub caps: Option<Vec<Capability>>,
    pub scope: Option<ScopeRequest>,
    pub expires: Option<String>,
    pub confirm_never_expires: bool,
}

pub fn parse_token_changes(raw: &Value) -> Result<TokenChanges, RpcError> {
    let reference = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| fail("bad-request: id"))?
        .to_owned();
    let name = raw
        .get("name")
        .map(|value| clean_token_name(Some(value)))
        .transpose()?;
    let caps = raw.get("caps").map(clean_caps).transpose()?;
    let scope = clean_scope(raw.get("scope"), caps.as_deref().unwrap_or(&[]))?;
    let expires = raw
        .get("expires")
        .map(|value| clean_expires(value, raw.get("confirmNeverExpires")))
        .transpose()?;
    if name.is_none() && caps.is_none() && scope.is_none() && expires.is_none() {
        return Err(fail(
            "bad-request: nothing to change (name, caps, scope or expires)",
        ));
    }
    Ok(TokenChanges {
        reference,
        name,
        caps: caps.map(|caps| held_from(&caps)),
        scope,
        expires,
        confirm_never_expires: raw.get("confirmNeverExpires").and_then(Value::as_bool)
            == Some(true),
    })
}

pub fn confirm_still_never(
    changes: &TokenChanges,
    expires_at: Option<&str>,
    name: &str,
) -> Result<(), RpcError> {
    if expires_at.is_none() && !changes.confirm_never_expires {
        return Err(fail(format!(
            "bad-request: the script token \"{name}\" never expires, so regenerating it needs confirmNeverExpires: true (ostia token update --yes-never-expires)"
        )));
    }
    Ok(())
}

pub fn regenerates(changes: &TokenChanges) -> bool {
    changes.caps.is_some() || changes.scope.is_some() || changes.expires.is_some()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReachWorkspace {
    pub workspace_id: String,
    pub name: String,
    pub work_dir: String,
    pub group_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReachGroup {
    pub group_id: String,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReachListing {
    pub workspaces: Vec<ReachWorkspace>,
    pub groups: Vec<ReachGroup>,
}

fn resolve_ref(reference: &str, entries: &[(&str, &str)], kind: &str) -> Result<String, RpcError> {
    if entries.iter().any(|(id, _)| *id == reference) {
        return Ok(reference.to_owned());
    }
    let matching: Vec<&str> = entries
        .iter()
        .filter(|(_, name)| *name == reference)
        .map(|(id, _)| *id)
        .collect();
    match matching.as_slice() {
        [] => Err(fail(format!("unknown-{kind}: {reference}"))),
        [id] => Ok((*id).to_owned()),
        _ => Err(fail(format!("ambiguous-{kind}: {reference} (pass its id)"))),
    }
}

fn resolve_all(
    references: &[String],
    entries: &[(&str, &str)],
    kind: &str,
) -> Result<Vec<String>, RpcError> {
    let mut out: Vec<String> = Vec::new();
    for reference in references {
        let id = resolve_ref(reference, entries, kind)?;
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

pub fn resolve_scope(
    request: &ScopeRequest,
    listing: &ReachListing,
) -> Result<ScriptTokenScope, RpcError> {
    let ScopeRequest::Limited {
        groups,
        workspaces,
        own_workspaces,
    } = request
    else {
        return Ok(ScriptTokenScope::All);
    };
    let group_entries: Vec<(&str, &str)> = listing
        .groups
        .iter()
        .map(|group| (group.group_id.as_str(), group.name.as_str()))
        .collect();
    let workspace_entries: Vec<(&str, &str)> = listing
        .workspaces
        .iter()
        .map(|workspace| (workspace.workspace_id.as_str(), workspace.name.as_str()))
        .collect();
    Ok(ScriptTokenScope::Limited {
        groups: resolve_all(groups, &group_entries, "group")?,
        workspaces: resolve_all(workspaces, &workspace_entries, "workspace")?,
        own_workspaces: *own_workspaces,
    })
}
