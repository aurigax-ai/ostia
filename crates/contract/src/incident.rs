use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

pub const INCIDENT_WINDOW_MS: u64 = 5 * 60_000;
pub const INCIDENT_EVENTS_MAX: usize = 50;
pub const INCIDENT_PANES_MAX: usize = 32;
pub const INCIDENT_STALL_MS: u64 = 8000;
pub const INCIDENT_KEPT_MAX: usize = 20;
pub const INCIDENT_KEEP_MS: u64 = 30 * 24 * 3_600_000;
pub const INCIDENT_BLOCK_TAG: &str = "ostia-incident";
pub const INCIDENT_WORDS_MAX: usize = 2000;

const UNSEEN_MAX: usize = 20;
const MAIL_MAX: u64 = 999;
const COUNT_MAX: u64 = 1_000_000;
const SINCE_MIN_MAX: u64 = 100_000;

const BLOCK_KEYS: [&str; 11] = [
    "version", "app", "platform", "agent", "settings", "pane", "trigger", "events", "unseen",
    "counts", "sinceMin",
];
const AGENT_KEYS: [&str; 2] = ["kind", "version"];
const SNAPSHOT_KEYS: [&str; 5] = ["agent", "state", "drafting", "mail", "alive"];
const CALL_KEYS: [&str; 10] = [
    "k", "at", "method", "from", "phase", "name", "ms", "code", "before", "after",
];
const STATE_KEYS: [&str; 4] = ["k", "at", "to", "from"];
const HOOK_KEYS: [&str; 4] = ["k", "at", "ok", "code"];
const MAIL_KEYS: [&str; 4] = ["k", "at", "code", "age"];
const WAKE_KEYS: [&str; 4] = ["k", "at", "code", "ms"];

static CODE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][a-z.-]{0,40}$"));
static METHOD: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][A-Za-z.]{0,60}$"));
static ALIAS: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^P[1-9][0-9]?$"));
static VERSION: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9A-Za-z.+-]{1,40}$"));
static COUNT_KEY: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][A-Za-z.-]{0,70}$"));

const TRIGGER_WORDS: [(&str, &str); 20] = [
    ("call-open", "A call never returned"),
    ("slow-call", "A call was slow"),
    ("call-cancelled", "A call was cancelled"),
    ("not-submitted", "Enter not submitted"),
    ("not-queued", "Message not queued"),
    ("not-started", "Agent did not start"),
    ("not-recorded", "Result not recorded"),
    ("still-open", "Pane did not close"),
    ("wake-not-ready", "Wake never got ready"),
    ("lease-timeout", "Mail waited too long"),
    ("pane-closed", "Mail target closed"),
    ("agent-refused", "Agent refused mail"),
    ("inbox-full", "Inbox full"),
    ("hook-failed", "A hook failed"),
    (
        "folder-not-trusted",
        "Agent run refused: folder not trusted",
    ),
    ("undelivered-hooks-off", "Mail not delivered: hooks off"),
    (
        "undelivered-idle-no-wake",
        "Mail not delivered: agent idle, not woken",
    ),
    (
        "undelivered-hibernated",
        "Mail not delivered: agent hibernated",
    ),
    (
        "undelivered-no-agent",
        "Mail not delivered: no agent in the pane",
    ),
    (
        "undelivered-rate-limited",
        "Mail not delivered: wake limit reached",
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncidentPeriod {
    Day,
    Week,
    Month,
}

pub const INCIDENT_PERIODS: [IncidentPeriod; 3] = [
    IncidentPeriod::Day,
    IncidentPeriod::Week,
    IncidentPeriod::Month,
];

impl IncidentPeriod {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Week => "7d",
            Self::Month => "30d",
        }
    }

    pub fn window_ms(&self) -> u64 {
        match self {
            Self::Day => 24 * 3_600_000,
            Self::Week => 7 * 24 * 3_600_000,
            Self::Month => INCIDENT_KEEP_MS,
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        INCIDENT_PERIODS
            .into_iter()
            .find(|period| period.as_str() == text)
    }
}

pub fn trigger_words(code: &str) -> String {
    match TRIGGER_WORDS.iter().find(|(known, _)| *known == code) {
        Some((_, words)) => (*words).to_owned(),
        None => code.replace('-', " "),
    }
}

#[derive(Debug, Serialize)]
pub struct IncidentSnapshot {
    pub agent: String,
    pub state: String,
    pub drafting: bool,
    pub mail: u64,
    pub alive: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallPhase {
    Start,
    End,
    Cancel,
    Phase,
}

#[derive(Debug, Serialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum IncidentEvent {
    Call {
        at: u64,
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        phase: CallPhase,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        before: Option<IncidentSnapshot>,
        #[serde(skip_serializing_if = "Option::is_none")]
        after: Option<IncidentSnapshot>,
    },
    State {
        at: u64,
        to: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<String>,
    },
    Hook {
        at: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    Mail {
        at: u64,
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        age: Option<u64>,
    },
    Wake {
        at: u64,
        code: String,
        ms: u64,
    },
}

#[derive(Debug, Serialize)]
pub struct IncidentAgent {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentBlock {
    pub version: u64,
    pub app: String,
    pub platform: String,
    pub agent: IncidentAgent,
    pub settings: Map<String, Value>,
    pub pane: String,
    pub trigger: String,
    pub events: Vec<IncidentEvent>,
    pub unseen: Vec<String>,
    pub counts: Map<String, Value>,
    pub since_min: u64,
}

pub fn parse_incident_block(value: &Value) -> Option<IncidentBlock> {
    let object = strict_object(value, &BLOCK_KEYS)?;
    if whole(object.get("version")?, 1)? != 1 {
        return None;
    }
    Some(IncidentBlock {
        version: 1,
        app: text(object.get("app")?, &VERSION)?,
        platform: text(object.get("platform")?, &CODE)?,
        agent: agent(object.get("agent")?)?,
        settings: settings(object.get("settings")?)?,
        pane: text(object.get("pane")?, &ALIAS)?,
        trigger: text(object.get("trigger")?, &CODE)?,
        events: array(object.get("events")?, INCIDENT_EVENTS_MAX)?
            .iter()
            .map(event)
            .collect::<Option<Vec<_>>>()?,
        unseen: array(object.get("unseen")?, UNSEEN_MAX)?
            .iter()
            .map(|value| text(value, &CODE))
            .collect::<Option<Vec<_>>>()?,
        counts: counts(object.get("counts")?)?,
        since_min: whole(object.get("sinceMin")?, SINCE_MIN_MAX)?,
    })
}

fn strict_object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    object
        .keys()
        .all(|key| keys.contains(&key.as_str()))
        .then_some(object)
}

fn optional<T>(
    object: &Map<String, Value>,
    key: &str,
    parse: impl FnOnce(&Value) -> Option<T>,
) -> Option<Option<T>> {
    match object.get(key) {
        None => Some(None),
        Some(value) => parse(value).map(Some),
    }
}

fn whole(value: &Value, max: u64) -> Option<u64> {
    let number = value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.fract() == 0.0 && *number >= 0.0 && *number <= max as f64)
            .map(|number| number as u64)
    })?;
    (number <= max).then_some(number)
}

fn millis(value: &Value) -> Option<u64> {
    whole(value, INCIDENT_WINDOW_MS * 2)
}

fn text(value: &Value, pattern: &Regex) -> Option<String> {
    value
        .as_str()
        .filter(|text| pattern.is_match(text))
        .map(str::to_owned)
}

fn array(value: &Value, max: usize) -> Option<&Vec<Value>> {
    value.as_array().filter(|items| items.len() <= max)
}

fn agent(value: &Value) -> Option<IncidentAgent> {
    let object = strict_object(value, &AGENT_KEYS)?;
    Some(IncidentAgent {
        kind: text(object.get("kind")?, &CODE)?,
        version: optional(object, "version", |value| text(value, &VERSION))?,
    })
}

fn settings(value: &Value) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    let mut settings = Map::new();
    for (key, flag) in object {
        if !CODE.is_match(key) {
            return None;
        }
        settings.insert(key.clone(), Value::Bool(flag.as_bool()?));
    }
    Some(settings)
}

fn counts(value: &Value) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    let mut counts = Map::new();
    for (key, count) in object {
        if !COUNT_KEY.is_match(key) {
            return None;
        }
        counts.insert(key.clone(), Value::from(whole(count, COUNT_MAX)?));
    }
    Some(counts)
}

fn snapshot(value: &Value) -> Option<IncidentSnapshot> {
    let object = strict_object(value, &SNAPSHOT_KEYS)?;
    Some(IncidentSnapshot {
        agent: text(object.get("agent")?, &CODE)?,
        state: text(object.get("state")?, &CODE)?,
        drafting: object.get("drafting")?.as_bool()?,
        mail: whole(object.get("mail")?, MAIL_MAX)?,
        alive: object.get("alive")?.as_bool()?,
    })
}

fn event(value: &Value) -> Option<IncidentEvent> {
    match value.get("k")?.as_str()? {
        "call" => call(value),
        "state" => state(value),
        "hook" => hook(value),
        "mail" => mail(value),
        "wake" => wake(value),
        _ => None,
    }
}

fn call(value: &Value) -> Option<IncidentEvent> {
    let object = strict_object(value, &CALL_KEYS)?;
    Some(IncidentEvent::Call {
        at: millis(object.get("at")?)?,
        method: text(object.get("method")?, &METHOD)?,
        from: optional(object, "from", |value| text(value, &ALIAS))?,
        phase: call_phase(object.get("phase")?)?,
        name: optional(object, "name", |value| text(value, &CODE))?,
        ms: optional(object, "ms", millis)?,
        code: optional(object, "code", |value| text(value, &CODE))?,
        before: optional(object, "before", snapshot)?,
        after: optional(object, "after", snapshot)?,
    })
}

fn call_phase(value: &Value) -> Option<CallPhase> {
    match value.as_str()? {
        "start" => Some(CallPhase::Start),
        "end" => Some(CallPhase::End),
        "cancel" => Some(CallPhase::Cancel),
        "phase" => Some(CallPhase::Phase),
        _ => None,
    }
}

fn state(value: &Value) -> Option<IncidentEvent> {
    let object = strict_object(value, &STATE_KEYS)?;
    Some(IncidentEvent::State {
        at: millis(object.get("at")?)?,
        to: text(object.get("to")?, &CODE)?,
        from: optional(object, "from", |value| text(value, &CODE))?,
    })
}

fn hook(value: &Value) -> Option<IncidentEvent> {
    let object = strict_object(value, &HOOK_KEYS)?;
    Some(IncidentEvent::Hook {
        at: millis(object.get("at")?)?,
        ok: object.get("ok")?.as_bool()?,
        code: optional(object, "code", |value| text(value, &CODE))?,
    })
}

fn mail(value: &Value) -> Option<IncidentEvent> {
    let object = strict_object(value, &MAIL_KEYS)?;
    Some(IncidentEvent::Mail {
        at: millis(object.get("at")?)?,
        code: text(object.get("code")?, &CODE)?,
        age: optional(object, "age", millis)?,
    })
}

fn wake(value: &Value) -> Option<IncidentEvent> {
    let object = strict_object(value, &WAKE_KEYS)?;
    Some(IncidentEvent::Wake {
        at: millis(object.get("at")?)?,
        code: text(object.get("code")?, &CODE)?,
        ms: millis(object.get("ms")?)?,
    })
}
