use std::sync::LazyLock;

use ostia_base::js::{js_number, js_number_text, static_regex};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::sandbox::{
    DEFAULT_SWITCHES, PACKAGE_DEFAULTS, PackageSettings, PortsPolicy, SANDBOX_SWITCHES,
    SandboxGlobals, WorkspaceSandbox, check_package_key, default_sandbox_globals, merge_controls,
    merge_switches,
};

const SECRET_GRANT_MODES: [&str; 3] = ["env", "file", "request"];

const OPTIONAL_LISTS: [&str; 5] = [
    "allowWrite",
    "denyRead",
    "denyWrite",
    "deniedDomains",
    "allowSockets",
];

static ENV_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$"));
static FILE_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z0-9._-]{1,128}$"));

fn string_list(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn list_or_empty(raw: &Value, key: &str) -> Option<Vec<String>> {
    match raw.get(key) {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(value) => string_list(value),
    }
}

fn is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n == 0.0),
        Value::String(text) => text.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    }
}

pub fn js_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number(text),
        Value::Array(items) => js_number(&array_text(items)),
        Value::Object(_) => f64::NAN,
    }
}

fn array_text(items: &[Value]) -> String {
    items
        .iter()
        .map(|item| match item {
            Value::Null => String::new(),
            Value::Bool(flag) => flag.to_string(),
            Value::Number(number) => number
                .as_f64()
                .map_or_else(|| "NaN".to_owned(), js_number_text),
            Value::String(text) => text.clone(),
            Value::Array(inner) => array_text(inner),
            Value::Object(_) => "[object Object]".to_owned(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn cooldown_days(value: &Value) -> Option<i64> {
    let days = js_to_number(value);
    if days.is_finite() && days.fract() == 0.0 && (0.0..=60.0).contains(&days) {
        (0..=60_i32)
            .find(|candidate| f64::from(*candidate) == days)
            .map(i64::from)
    } else {
        None
    }
}

fn parse_controls(value: Option<&Value>) -> Option<Map<String, Value>> {
    let raw = match value {
        None => return Some(Map::new()),
        Some(Value::Null) => return None,
        Some(raw) if !raw.is_object() && !raw.is_array() => return None,
        Some(raw) => raw,
    };
    let mut out = Map::new();
    if let Some(flag) = raw.get("allWorkspaces") {
        out.insert("allWorkspaces".to_owned(), Value::Bool(flag.as_bool()?));
    }
    if let Some(browser) = raw.get("browser") {
        match browser.as_str() {
            Some("allowlist" | "unrestricted") => {
                out.insert("browser".to_owned(), browser.clone());
            }
            _ => return None,
        }
    }
    Some(out)
}

pub fn parse_switches(value: Option<&Value>) -> Option<Map<String, Value>> {
    let Some(value) = value else {
        return Some(Map::new());
    };
    if !value.is_object() {
        return None;
    }
    let mut out = Map::new();
    for key in SANDBOX_SWITCHES {
        if let Some(flag) = value.get(key) {
            out.insert(key.to_owned(), Value::Bool(flag.as_bool()?));
        }
    }
    Some(out)
}

fn optional_lists(raw: &Value) -> Option<Vec<(&'static str, Vec<String>)>> {
    let mut out = Vec::new();
    for key in OPTIONAL_LISTS {
        let list = list_or_empty(raw, key)?;
        if !list.is_empty() {
            out.push((key, list));
        }
    }
    Some(out)
}

pub fn parse_workspace_sandbox(value: &Value) -> Option<WorkspaceSandbox> {
    if !value.is_object() && !value.is_array() {
        return None;
    }
    let enabled = value.get("enabled")?.as_bool()?;
    let allow_read = list_or_empty(value, "allowRead")?;
    let domains = list_or_empty(value, "domains")?;
    let controls = parse_controls(value.get("controls"))?;
    let lists = optional_lists(value)?;
    let switches = parse_switches(value.get("switches"))?;
    let ports = match value.get("ports") {
        None => None,
        Some(raw) => {
            let name = raw.as_str()?;
            PortsPolicy::parse(name)?;
            Some(name.to_owned())
        }
    };
    let secrets = parse_secret_grants(value.get("secrets"))?;
    let packages = match value.get("packages") {
        None => None,
        Some(raw) => Some(parse_workspace_packages(raw)?),
    };
    let mut sandbox = WorkspaceSandbox {
        enabled,
        allow_read,
        domains,
        controls,
        ports,
        switches: (!switches.is_empty()).then_some(switches),
        secrets: (!secrets.is_empty()).then_some(Value::Array(secrets)),
        packages,
        ..WorkspaceSandbox::empty()
    };
    for (key, list) in lists {
        let slot = match key {
            "allowWrite" => &mut sandbox.allow_write,
            "denyRead" => &mut sandbox.deny_read,
            "denyWrite" => &mut sandbox.deny_write,
            "deniedDomains" => &mut sandbox.denied_domains,
            _ => &mut sandbox.allow_sockets,
        };
        *slot = Some(list);
    }
    Some(sandbox)
}

pub fn parse_sandbox_globals(value: &Value) -> SandboxGlobals {
    if !value.is_object() {
        return default_sandbox_globals();
    }
    let defaults = default_sandbox_globals();
    let list = |key: &str| value.get(key).and_then(string_list);
    let controls = parse_controls(value.get("controls")).unwrap_or_default();
    let switches = parse_switches(value.get("switches")).unwrap_or_default();
    SandboxGlobals {
        allow_read: list("allowRead").unwrap_or(defaults.allow_read),
        allow_write: list("allowWrite").unwrap_or_default(),
        deny_read: list("denyRead").unwrap_or_default(),
        deny_write: list("denyWrite").unwrap_or_default(),
        allowed_domains: list("allowedDomains").unwrap_or(defaults.allowed_domains),
        denied_domains: list("deniedDomains").unwrap_or_default(),
        allow_sockets: list("allowSockets").unwrap_or_default(),
        controls: merge_controls(defaults.controls, &controls),
        switches: merge_switches(DEFAULT_SWITCHES, &switches),
        packages: value
            .get("packages")
            .and_then(parse_package_settings)
            .unwrap_or(PACKAGE_DEFAULTS),
        ports_policy: value
            .get("portsPolicy")
            .and_then(Value::as_str)
            .and_then(PortsPolicy::parse)
            .unwrap_or(defaults.ports_policy),
    }
}

fn check_secret_grant(mode: &str, name: Option<&str>, id: &str) -> bool {
    if id.is_empty() || !SECRET_GRANT_MODES.contains(&mode) {
        return false;
    }
    match (name, mode) {
        (None, _) => true,
        (Some(name), "env") => ENV_NAME.is_match(name),
        (Some(name), "file") => FILE_NAME.is_match(name) && name != "agent.sock",
        _ => false,
    }
}

pub fn parse_secret_grants(value: Option<&Value>) -> Option<Vec<Value>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let mut out = Vec::new();
    for raw in value.as_array()? {
        if !raw.is_object() {
            return None;
        }
        let id = raw.get("id")?.as_str()?;
        let mode = raw.get("mode").and_then(Value::as_str)?;
        let name = raw.get("name").and_then(Value::as_str);
        if !check_secret_grant(mode, name, id) {
            return None;
        }
        let mut grant = Map::new();
        grant.insert("id".to_owned(), json!(id));
        grant.insert("mode".to_owned(), json!(mode));
        if let Some(name) = name {
            grant.insert("name".to_owned(), json!(name));
        }
        out.push(Value::Object(grant));
    }
    Some(out)
}

fn package_list(value: &Value) -> Option<Vec<String>> {
    string_list(value).filter(|list| list.iter().all(|key| check_package_key(key)))
}

fn parse_package_settings(value: &Value) -> Option<PackageSettings> {
    if !value.is_object() && !value.is_array() {
        return None;
    }
    let deny_list = match value.get("denyList") {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(raw) => package_list(raw),
    }?;
    let allow_only = match value.get("allowOnly") {
        None | Some(Value::Null) => None,
        Some(raw) => {
            let list = package_list(raw);
            if list.is_none() && !is_falsy(raw) {
                return None;
            }
            list
        }
    };
    let cooldown = match value.get("cooldownDays") {
        None | Some(Value::Null) => PACKAGE_DEFAULTS.cooldown_days,
        Some(raw) => cooldown_days(raw)?,
    };
    Some(PackageSettings {
        malware: value.get("malware") != Some(&Value::Bool(false)),
        cooldown_days: cooldown,
        deny_list,
        allow_only,
    })
}

pub fn parse_workspace_packages(value: &Value) -> Option<Value> {
    if !value.is_object() && !value.is_array() {
        return None;
    }
    let mut out = Map::new();
    if let Some(raw) = value.get("malware") {
        out.insert("malware".to_owned(), Value::Bool(raw.as_bool()?));
    }
    if let Some(raw) = value.get("cooldownDays") {
        out.insert("cooldownDays".to_owned(), json!(cooldown_days(raw)?));
    }
    if let Some(raw) = value.get("denyList") {
        out.insert("denyList".to_owned(), json!(package_list(raw)?));
    }
    if let Some(raw) = value.get("allowOnly") {
        let list = if raw.is_null() {
            Value::Null
        } else {
            json!(package_list(raw)?)
        };
        out.insert("allowOnly".to_owned(), list);
    }
    if let Some(raw) = value.get("allowances") {
        out.insert("allowances".to_owned(), json!(string_list(raw)?));
    }
    Some(Value::Object(out))
}
