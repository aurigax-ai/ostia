use std::cmp::Ordering;
use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

pub const SANDBOX_PATH_KINDS: [&str; 5] = [
    "allowRead",
    "allowWrite",
    "denyRead",
    "denyWrite",
    "allowSockets",
];
pub const SANDBOX_SWITCHES: [&str; 3] = ["unixSockets", "gitConfig", "strictDomains"];
pub const PORTS_POLICIES: [&str; 3] = ["ask", "allow", "deny"];
pub const SANDBOX_LIST_MAX: usize = 200;
pub const SANDBOX_PATH_MAX: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortsPolicy {
    Ask,
    Allow,
    Deny,
}

impl PortsPolicy {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "ask" => Some(Self::Ask),
            "allow" => Some(Self::Allow),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserControl {
    Allowlist,
    Unrestricted,
}

impl BrowserControl {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "allowlist" => Some(Self::Allowlist),
            "unrestricted" => Some(Self::Unrestricted),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SandboxControls {
    pub all_workspaces: bool,
    pub browser: BrowserControl,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SandboxSwitches {
    pub unix_sockets: bool,
    pub git_config: bool,
    pub strict_domains: bool,
}

pub const DEFAULT_SWITCHES: SandboxSwitches = SandboxSwitches {
    unix_sockets: true,
    git_config: false,
    strict_domains: false,
};

pub const DEFAULT_CONTROLS: SandboxControls = SandboxControls {
    all_workspaces: false,
    browser: BrowserControl::Allowlist,
};

#[derive(Clone, Debug, PartialEq)]
pub struct PackageSettings {
    pub malware: bool,
    pub cooldown_days: i64,
    pub deny_list: Vec<String>,
    pub allow_only: Option<Vec<String>>,
}

pub const PACKAGE_DEFAULTS: PackageSettings = PackageSettings {
    malware: true,
    cooldown_days: 2,
    deny_list: Vec::new(),
    allow_only: None,
};

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedPackages {
    pub malware: bool,
    pub cooldown_days: i64,
    pub deny_list: Vec<String>,
    pub allow_only: Option<Vec<String>>,
    pub allowances: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SandboxGlobals {
    pub allow_read: Vec<String>,
    pub allow_write: Vec<String>,
    pub deny_read: Vec<String>,
    pub deny_write: Vec<String>,
    pub allowed_domains: Vec<String>,
    pub denied_domains: Vec<String>,
    pub allow_sockets: Vec<String>,
    pub controls: SandboxControls,
    pub switches: SandboxSwitches,
    pub ports_policy: PortsPolicy,
    pub packages: PackageSettings,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedSandbox {
    pub allow_read: Vec<String>,
    pub allow_write: Vec<String>,
    pub deny_read: Vec<String>,
    pub deny_write: Vec<String>,
    pub domains: Vec<String>,
    pub denied_domains: Vec<String>,
    pub allow_sockets: Vec<String>,
    pub controls: SandboxControls,
    pub switches: SandboxSwitches,
    pub ports_policy: PortsPolicy,
}

pub const DEFAULT_ALLOW_READ: [&str; 22] = [
    "~/.zshrc",
    "~/.zshenv",
    "~/.zprofile",
    "~/.bashrc",
    "~/.bash_profile",
    "~/.profile",
    "~/.p10k.zsh",
    "~/.oh-my-zsh",
    "~/.cargo",
    "~/.rustup",
    "~/.local/bin",
    "~/.local/share/claude",
    "~/.local/share/uv/tools",
    "~/.local/share/uv/python",
    "~/.local/share/pipx",
    "~/.nvm",
    "~/.dircolors",
    "~/.config/vivid",
    "~/.config/bat",
    "~/.config/eza",
    "~/.config/lsd",
    "~/.config/starship.toml",
];

pub const DEFAULT_ALLOWED_DOMAINS: [&str; 13] = [
    "api.anthropic.com",
    "api.openai.com",
    "chatgpt.com",
    "github.com",
    "*.github.com",
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "static.crates.io",
    "index.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
];

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

pub fn default_sandbox_globals() -> SandboxGlobals {
    SandboxGlobals {
        allow_read: owned(&DEFAULT_ALLOW_READ),
        allow_write: Vec::new(),
        deny_read: Vec::new(),
        deny_write: Vec::new(),
        allowed_domains: owned(&DEFAULT_ALLOWED_DOMAINS),
        denied_domains: Vec::new(),
        allow_sockets: Vec::new(),
        controls: DEFAULT_CONTROLS,
        switches: DEFAULT_SWITCHES,
        ports_policy: PortsPolicy::Ask,
        packages: PACKAGE_DEFAULTS,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSandbox {
    pub enabled: bool,
    pub allow_read: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_write: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny_read: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny_write: Option<Vec<String>>,
    pub domains: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_sockets: Option<Vec<String>>,
    pub controls: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switches: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ports: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secrets: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packages: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxMergeRefusal {
    Mixed,
    Differs,
}

impl WorkspaceSandbox {
    pub fn empty() -> Self {
        Self {
            enabled: false,
            allow_read: Vec::new(),
            allow_write: None,
            deny_read: None,
            deny_write: None,
            domains: Vec::new(),
            denied_domains: None,
            allow_sockets: None,
            controls: Map::new(),
            switches: None,
            ports: None,
            secrets: None,
            packages: None,
        }
    }
}

fn utf16_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            let mut texts: Vec<String> = items
                .into_iter()
                .map(|item| canonical(item).to_string())
                .collect();
            texts.sort_by(|a, b| utf16_order(a, b));
            Value::Array(texts.into_iter().map(Value::String).collect())
        }
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map
                .into_iter()
                .map(|(key, item)| (key, canonical(item)))
                .collect();
            entries.sort_by(|a, b| utf16_order(&a.0, &b.0));
            Value::Object(entries.into_iter().collect())
        }
        other => other,
    }
}

pub fn same_workspace_sandbox(a: &WorkspaceSandbox, b: &WorkspaceSandbox) -> bool {
    serde_json::to_value(a).ok().map(canonical) == serde_json::to_value(b).ok().map(canonical)
}

pub fn sandbox_merge_refusal(
    source: &WorkspaceSandbox,
    target: &WorkspaceSandbox,
) -> Option<SandboxMergeRefusal> {
    if source.enabled != target.enabled {
        return Some(SandboxMergeRefusal::Mixed);
    }
    if source.enabled && !same_workspace_sandbox(source, target) {
        return Some(SandboxMergeRefusal::Differs);
    }
    None
}

fn union(a: &[String], b: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in a.iter().chain(b) {
        if !out.contains(item) {
            out.push(item.clone());
        }
    }
    out
}

fn listed(list: Option<&[String]>) -> &[String] {
    list.unwrap_or_default()
}

fn override_flag(map: &Map<String, Value>, key: &str, base: bool) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(base)
}

pub fn merge_controls(base: SandboxControls, over: &Map<String, Value>) -> SandboxControls {
    SandboxControls {
        all_workspaces: override_flag(over, "allWorkspaces", base.all_workspaces),
        browser: over
            .get("browser")
            .and_then(Value::as_str)
            .and_then(BrowserControl::parse)
            .unwrap_or(base.browser),
    }
}

pub fn merge_switches(base: SandboxSwitches, over: &Map<String, Value>) -> SandboxSwitches {
    SandboxSwitches {
        unix_sockets: override_flag(over, "unixSockets", base.unix_sockets),
        git_config: override_flag(over, "gitConfig", base.git_config),
        strict_domains: override_flag(over, "strictDomains", base.strict_domains),
    }
}

pub fn resolve_sandbox(
    globals: &SandboxGlobals,
    workspace: &WorkspaceSandbox,
    session_domains: &[String],
) -> ResolvedSandbox {
    ResolvedSandbox {
        allow_read: union(&globals.allow_read, &workspace.allow_read),
        allow_write: union(
            &globals.allow_write,
            listed(workspace.allow_write.as_deref()),
        ),
        deny_read: union(&globals.deny_read, listed(workspace.deny_read.as_deref())),
        deny_write: union(&globals.deny_write, listed(workspace.deny_write.as_deref())),
        domains: union(
            &union(&globals.allowed_domains, &workspace.domains),
            session_domains,
        ),
        denied_domains: union(
            &globals.denied_domains,
            listed(workspace.denied_domains.as_deref()),
        ),
        allow_sockets: union(
            &globals.allow_sockets,
            listed(workspace.allow_sockets.as_deref()),
        ),
        controls: merge_controls(globals.controls, &workspace.controls),
        switches: merge_switches(
            globals.switches,
            workspace.switches.as_ref().unwrap_or(&Map::new()),
        ),
        ports_policy: workspace
            .ports
            .as_deref()
            .and_then(PortsPolicy::parse)
            .unwrap_or(globals.ports_policy),
    }
}

const LABEL: &str = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

static HOST_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^(?:\*\.)?{LABEL}(?:\.{LABEL})+(?::([0-9]{{1,5}}))?$"
    ))
});

static IP_LITERAL: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9.]+(?::[0-9]+)?$"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DomainCheck {
    Valid(String),
    Refused(&'static str),
}

pub fn check_domain_pattern(input: &str) -> DomainCheck {
    let domain = js_trim(input).to_lowercase();
    if domain.is_empty() {
        return DomainCheck::Refused("empty");
    }
    if domain == "*" || domain.starts_with("*:") {
        return DomainCheck::Refused("wildcard-all");
    }
    if domain == "localhost" || domain.ends_with(".localhost") {
        return DomainCheck::Refused("localhost");
    }
    if IP_LITERAL.is_match(&domain) || domain.contains('[') || domain.contains("::") {
        return DomainCheck::Refused("ip-literal");
    }
    let Some(captures) = HOST_PATTERN.captures(&domain) else {
        return DomainCheck::Refused("invalid");
    };
    if let Some(port) = captures.get(1) {
        let port: u32 = port.as_str().parse().unwrap_or(u32::MAX);
        if !(1..=65535).contains(&port) {
            return DomainCheck::Refused("invalid-port");
        }
    }
    DomainCheck::Valid(domain)
}

const EXPOSE_PORT_MIN: u16 = 1024;

pub fn check_expose_port(input: &str) -> Option<u16> {
    let text = js_trim(input);
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port: u16 = text.parse().ok()?;
    (port >= EXPOSE_PORT_MIN).then_some(port)
}

fn split_pattern(pattern: &str) -> (String, Option<u32>) {
    let lowered = pattern.to_lowercase();
    if lowered.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return (String::new(), None);
    }
    if let Some((host, digits)) = lowered.rsplit_once(':')
        && (1..=5).contains(&digits.len())
        && digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return (host.to_owned(), digits.parse().ok());
    }
    (lowered, None)
}

pub fn host_matches(host: &str, port: u16, patterns: &[String]) -> bool {
    let target = host.to_lowercase();
    patterns.iter().any(|raw| {
        let (pattern_host, pattern_port) = split_pattern(raw);
        if pattern_port.is_some_and(|wanted| wanted != u32::from(port)) {
            return false;
        }
        match pattern_host.strip_prefix('*') {
            Some(suffix) if suffix.starts_with('.') => target.ends_with(suffix),
            _ => target == pattern_host,
        }
    })
}

static PACKAGE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^(?:npm|PyPI|crates\.io|Go):[^{JS_SPACE_CLASS}@][^{JS_SPACE_CLASS}]*$"
    ))
});

pub fn check_package_key(value: &str) -> bool {
    PACKAGE_KEY.is_match(value)
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub fn resolve_packages(
    globals: &SandboxGlobals,
    workspace: &WorkspaceSandbox,
) -> ResolvedPackages {
    let base = &globals.packages;
    let own = workspace.packages.as_ref();
    let field = |key: &str| own.and_then(|packages| packages.get(key));
    ResolvedPackages {
        malware: field("malware")
            .and_then(Value::as_bool)
            .unwrap_or(base.malware),
        cooldown_days: field("cooldownDays")
            .and_then(Value::as_i64)
            .unwrap_or(base.cooldown_days),
        deny_list: union(
            &base.deny_list,
            &field("denyList").map(strings).unwrap_or_default(),
        ),
        allow_only: match field("allowOnly") {
            None => base.allow_only.clone(),
            Some(list @ Value::Array(_)) => Some(strings(list)),
            Some(Value::Null) => None,
            Some(_) => base.allow_only.clone(),
        },
        allowances: field("allowances").map(strings).unwrap_or_default(),
    }
}
