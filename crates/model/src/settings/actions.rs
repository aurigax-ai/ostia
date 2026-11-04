use std::collections::HashSet;
use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::{Captures, Regex};
use serde::Serialize;
use serde_json::{Map, Value};

pub const ACTION_ICONS: [&str; 25] = [
    "lightning",
    "play",
    "terminal",
    "globe",
    "folder",
    "file",
    "git-branch",
    "bug",
    "rocket",
    "sparkle",
    "robot",
    "code",
    "book",
    "gear",
    "wrench",
    "refresh",
    "search",
    "database",
    "package",
    "flask",
    "eye",
    "link",
    "chat",
    "checklist",
    "broom",
];

pub(crate) const PANE_KINDS: [&str; 6] = ["terminal", "editor", "browser", "git", "diff", "view"];

pub(crate) const ACTION_PLACES: [&str; 2] = ["paneHeader", "tabMenu"];

pub const ACTION_TITLE_MAX: usize = 60;
pub const ACTIONS_MAX: usize = 50;
const ACTION_ARGS_MAX: usize = 4096;

pub(crate) static ACTION_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z0-9][a-z0-9-]{0,39}$"));
static COMMAND_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"));
static CONTEXT_PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{(cwd|file)\}"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionPlace {
    PaneHeader,
    TabMenu,
}

impl ActionPlace {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "paneHeader" => Some(Self::PaneHeader),
            "tabMenu" => Some(Self::TabMenu),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UserAction {
    pub id: String,
    pub title: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(rename = "in")]
    pub places: Vec<ActionPlace>,
    #[serde(rename = "paneKinds", skip_serializing_if = "Option::is_none")]
    pub pane_kinds: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionContext {
    pub cwd: Option<String>,
    pub file: Option<String>,
}

fn subset<T>(raw: &Value, parse: impl Fn(&str) -> Option<T>) -> Option<Vec<T>>
where
    T: PartialEq,
{
    let mut out: Vec<T> = Vec::new();
    for item in raw.as_array()? {
        let parsed = parse(item.as_str()?)?;
        if !out.contains(&parsed) {
            out.push(parsed);
        }
    }
    Some(out)
}

fn parse_action(raw: &Value) -> Option<UserAction> {
    let record = raw.as_object()?;
    let id = record.get("id")?.as_str()?;
    if !ACTION_ID.is_match(id) {
        return None;
    }
    let title = record.get("title")?.as_str()?;
    if js_trim(title).is_empty() || utf16_len(title) > ACTION_TITLE_MAX {
        return None;
    }
    let command = record.get("command")?.as_str()?;
    if !COMMAND_ID.is_match(command) {
        return None;
    }
    let args = match record.get("args") {
        None => None,
        Some(Value::Object(args)) => {
            let text = serde_json::to_string(args).ok()?;
            if utf16_len(&text) > ACTION_ARGS_MAX {
                return None;
            }
            Some(args.clone())
        }
        Some(_) => return None,
    };
    let icon = match record.get("icon") {
        None => None,
        Some(value) => {
            let name = value.as_str()?;
            if !ACTION_ICONS.contains(&name) {
                return None;
            }
            Some(name.to_owned())
        }
    };
    let places = match record.get("in") {
        None => Vec::new(),
        Some(value) => subset(value, ActionPlace::parse)?,
    };
    let pane_kinds = match record.get("paneKinds") {
        None => None,
        Some(value) => Some(subset(value, |kind| {
            PANE_KINDS.contains(&kind).then(|| kind.to_owned())
        })?),
    };
    Some(UserAction {
        id: id.to_owned(),
        title: title.to_owned(),
        command: command.to_owned(),
        args,
        icon,
        places,
        pane_kinds,
    })
}

pub fn parse_actions(raw: &Value) -> Vec<UserAction> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in entries.iter().take(ACTIONS_MAX) {
        let Some(action) = parse_action(entry) else {
            continue;
        };
        if seen.insert(action.id.clone()) {
            out.push(action);
        }
    }
    out
}

pub fn action_fingerprint(command: &str, args: Option<&Map<String, Value>>) -> String {
    Value::Array(vec![
        Value::String(command.to_owned()),
        args.map_or(Value::Null, |map| Value::Object(map.clone())),
    ])
    .to_string()
}

fn fill_value(value: &Value, ctx: &ActionContext) -> Value {
    match value {
        Value::String(text) => Value::String(
            CONTEXT_PLACEHOLDER
                .replace_all(text, |caps: &Captures| {
                    let found = if &caps[1] == "cwd" {
                        &ctx.cwd
                    } else {
                        &ctx.file
                    };
                    found.clone().unwrap_or_default()
                })
                .into_owned(),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| fill_value(item, ctx)).collect())
        }
        Value::Object(map) => Value::Object(fill_map(map, ctx)),
        other => other.clone(),
    }
}

fn fill_map(map: &Map<String, Value>, ctx: &ActionContext) -> Map<String, Value> {
    map.iter()
        .map(|(key, value)| (key.clone(), fill_value(value, ctx)))
        .collect()
}

pub fn fill_args(
    args: Option<&Map<String, Value>>,
    ctx: &ActionContext,
) -> Option<Map<String, Value>> {
    args.map(|map| fill_map(map, ctx))
}

pub fn actions_for(actions: &[UserAction], place: ActionPlace, kind: &str) -> Vec<UserAction> {
    actions
        .iter()
        .filter(|action| {
            action.places.contains(&place)
                && action
                    .pane_kinds
                    .as_ref()
                    .is_none_or(|kinds| kinds.iter().any(|allowed| allowed == kind))
        })
        .cloned()
        .collect()
}
