use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use ostia_base::WorkspaceId;
use ostia_base::clock::Clock;
use ostia_base::js::{JS_DOT, JS_SPACE_CLASS, js_trim, static_regex};
use ostia_contract::sandbox::{DomainCheck, check_domain_pattern};
use ostia_contract::utf16_prefix::utf16_prefix;
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;

pub const VIOLATIONS_PER_WORKSPACE: usize = 200;
pub const VIOLATION_TEXT_MAX: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxViolationKind {
    Network,
    Write,
    Read,
    Other,
}

impl SandboxViolationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Write => "write",
            Self::Read => "read",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxViolationReason {
    NotAllowed,
    Blocked,
    Refused,
    Address,
    Request,
    Outside,
    ReadOnly,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedViolation {
    pub kind: SandboxViolationKind,
    pub target: String,
    pub reason: SandboxViolationReason,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_host: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxViolation {
    pub kind: SandboxViolationKind,
    pub target: String,
    pub reason: SandboxViolationReason,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_host: Option<String>,
    pub id: String,
    pub count: u64,
    pub last: i64,
}

static NETWORK: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^deny network-outbound ({JS_DOT}+):([0-9]{{1,5}}) \(({JS_DOT}*)\)$"
    ))
});
static REQUEST: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^deny http-request ([^{JS_SPACE_CLASS}]+) ([^{JS_SPACE_CLASS}]+) \(({JS_DOT}*)\)$"
    ))
});
static WRITE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^deny ([^{JS_SPACE_CLASS}]+) (/{JS_DOT}*)$")));
static SEATBELT: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^[^{JS_SPACE_CLASS}]+\([0-9]+\) deny\([0-9]+\) ([^{JS_SPACE_CLASS}]+) ({JS_DOT}+)$"
    ))
});

fn seatbelt_kind(operation: &str) -> SandboxViolationKind {
    if operation.starts_with("file-read") {
        SandboxViolationKind::Read
    } else if operation.starts_with("file-write") {
        SandboxViolationKind::Write
    } else if operation.starts_with("network") {
        SandboxViolationKind::Network
    } else {
        SandboxViolationKind::Other
    }
}

fn clean(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|ch| *ch >= ' ' && *ch != '\u{7f}')
        .collect();
    utf16_prefix(&kept, VIOLATION_TEXT_MAX).to_owned()
}

fn network_reason(text: &str) -> SandboxViolationReason {
    match text {
        "host is not on the allow list" => SandboxViolationReason::NotAllowed,
        "host is on the deny list" => SandboxViolationReason::Blocked,
        "user denied" => SandboxViolationReason::Refused,
        _ if text.starts_with("resolved to ") => SandboxViolationReason::Address,
        _ => SandboxViolationReason::Other,
    }
}

pub fn parse_violation_line(raw: &str) -> ParsedViolation {
    let line = clean(js_trim(raw));
    if let Some(network) = NETWORK.captures(&line) {
        let host = &network[1];
        let reason = network_reason(&network[3]);
        let allowable = matches!(
            reason,
            SandboxViolationReason::NotAllowed | SandboxViolationReason::Refused
        ) && matches!(check_domain_pattern(host), DomainCheck::Valid(_));
        let show_detail = matches!(
            reason,
            SandboxViolationReason::Other | SandboxViolationReason::Address
        );
        return ParsedViolation {
            kind: SandboxViolationKind::Network,
            target: format!("{host}:{}", &network[2]),
            reason,
            detail: if show_detail {
                network[3].to_owned()
            } else {
                String::new()
            },
            allow_host: allowable.then(|| host.to_lowercase()),
        };
    }
    if let Some(request) = REQUEST.captures(&line) {
        return ParsedViolation {
            kind: SandboxViolationKind::Network,
            target: request[2].to_owned(),
            reason: SandboxViolationReason::Request,
            detail: request[3].to_owned(),
            allow_host: None,
        };
    }
    if let Some(write) = WRITE.captures(&line) {
        return ParsedViolation {
            kind: SandboxViolationKind::Write,
            target: write[2].to_owned(),
            reason: SandboxViolationReason::Outside,
            detail: write[1].to_owned(),
            allow_host: None,
        };
    }
    if let Some(seatbelt) = SEATBELT.captures(&line) {
        return ParsedViolation {
            kind: seatbelt_kind(&seatbelt[1]),
            target: seatbelt[2].to_owned(),
            reason: SandboxViolationReason::Other,
            detail: seatbelt[1].to_owned(),
            allow_host: None,
        };
    }
    ParsedViolation {
        kind: SandboxViolationKind::Other,
        target: line,
        reason: SandboxViolationReason::Other,
        detail: String::new(),
        allow_host: None,
    }
}

fn key_of(kind: SandboxViolationKind, target: &str, detail: &str) -> String {
    format!("{}\u{0}{target}\u{0}{detail}", kind.as_str())
}

#[derive(Clone)]
pub struct ViolationLog {
    now: Clock,
    entries: Arc<Mutex<HashMap<WorkspaceId, Vec<SandboxViolation>>>>,
}

impl ViolationLog {
    pub fn new(now: Clock) -> Self {
        Self {
            now,
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn add(&self, workspace_id: &WorkspaceId, parsed: ParsedViolation) {
        if parsed.target.is_empty() {
            return;
        }
        let key = key_of(parsed.kind, &parsed.target, &parsed.detail);
        let last = (self.now)();
        let mut entries = self.entries.lock();
        let list = entries.entry(workspace_id.clone()).or_default();
        let previous = list.iter().position(|row| row.id == key);
        let count = previous.map_or(0, |index| list[index].count) + 1;
        if let Some(index) = previous {
            list.remove(index);
        }
        list.push(SandboxViolation {
            kind: parsed.kind,
            target: parsed.target,
            reason: parsed.reason,
            detail: parsed.detail,
            allow_host: parsed.allow_host,
            id: key,
            count,
            last,
        });
        if list.len() > VIOLATIONS_PER_WORKSPACE {
            let excess = list.len() - VIOLATIONS_PER_WORKSPACE;
            list.drain(..excess);
        }
    }

    pub fn list(&self, workspace_id: &WorkspaceId) -> Vec<SandboxViolation> {
        self.entries
            .lock()
            .get(workspace_id)
            .map_or_else(Vec::new, |list| list.iter().rev().cloned().collect())
    }

    pub fn clear(&self, workspace_id: &WorkspaceId) {
        self.entries.lock().remove(workspace_id);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteRefusal {
    Outside,
    ReadOnly,
}

pub fn record_violations(
    log: &ViolationLog,
    write_refusal: impl Fn(&str) -> Option<WriteRefusal>,
    workspace_id: &WorkspaceId,
    lines: &[&str],
) {
    for line in lines {
        let parsed = parse_violation_line(line);
        if parsed.reason != SandboxViolationReason::Outside {
            log.add(workspace_id, parsed);
            continue;
        }
        let Some(refusal) = write_refusal(&parsed.target) else {
            continue;
        };
        let reason = match refusal {
            WriteRefusal::Outside => SandboxViolationReason::Outside,
            WriteRefusal::ReadOnly => SandboxViolationReason::ReadOnly,
        };
        log.add(workspace_id, ParsedViolation { reason, ..parsed });
    }
}
