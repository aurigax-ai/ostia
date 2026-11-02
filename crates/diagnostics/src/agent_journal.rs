use std::sync::Arc;

use ostia_contract::agent_issues::{
    BudgetBreach, MAIL_LEASE_TIMEOUT, OVER_BUDGET, READBACK_CODES, READBACK_MISMATCH,
    WAKE_NOT_READY, budget_breach, verb_code,
};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

use ostia_base::js::static_regex;

use crate::app_log::{AppLog, LogFields};
use crate::incident_timeline::IncidentTimeline;

pub const AGENT_JOURNAL_FILE_NAME: &str = "agent-journal.log";
pub const AGENT_JOURNAL_MAX_BYTES: u64 = 512 * 1024;
pub const AGENT_JOURNAL_KEEP: usize = 2;

static METHOD: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][A-Za-z.]{0,60}$"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCaller {
    Pane,
    Script,
    Extension,
}

impl AgentCaller {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pane => "pane",
            Self::Script => "script",
            Self::Extension => "extension",
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentCall {
    pub method: String,
    pub caller: AgentCaller,
    pub ms: f64,
    pub bytes: u64,
    pub code: Option<String>,
}

pub trait JournalIncidents: Send + Sync {
    fn mail(&self, pane_id: &str, code: &str, age_ms: f64);
    fn wake(&self, pane_id: &str, code: &str, ms: f64);
    fn hook(&self, pane_id: &str, ok: bool, code: Option<&str>);
}

pub struct AgentJournal {
    log: Arc<dyn AppLog>,
    incidents: Option<Arc<dyn JournalIncidents>>,
}

fn js_round(value: f64) -> i64 {
    let floor = value.floor();
    let rounded = if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    rounded as i64
}

fn whole_ms(ms: f64) -> u64 {
    if ms.is_nan() || ms <= 0.0 {
        0
    } else {
        ms.ceil() as u64
    }
}

impl AgentJournal {
    pub fn new(log: Arc<dyn AppLog>, incidents: Option<Arc<dyn JournalIncidents>>) -> Self {
        Self { log, incidents }
    }

    pub fn call(&self, call: AgentCall) {
        let code = call.code.as_deref().map(verb_code);
        let over = budget_breach(&call.method, whole_ms(call.ms), call.bytes);
        let outcome = match &code {
            None => "ok",
            Some(code) if READBACK_CODES.contains(&code.as_str()) => READBACK_MISMATCH,
            Some(_) => "error",
        };
        let method = if METHOD.is_match(&call.method) {
            call.method.as_str()
        } else {
            "other"
        };
        let mut fields = LogFields::new();
        fields.insert("method".to_owned(), Value::from(method));
        fields.insert("caller".to_owned(), Value::from(call.caller.as_str()));
        fields.insert("outcome".to_owned(), Value::from(outcome));
        if let Some(code) = &code {
            fields.insert("code".to_owned(), Value::from(code.as_str()));
        }
        fields.insert("ms".to_owned(), Value::from(js_round(call.ms)));
        fields.insert("bytes".to_owned(), Value::from(call.bytes));
        if let Some(over) = over {
            let name = match over {
                BudgetBreach::Ms => "ms",
                BudgetBreach::Bytes => "bytes",
            };
            fields.insert("over".to_owned(), Value::from(name));
        }
        if over.is_some() || outcome != "ok" {
            let event = if over.is_some() && outcome == "ok" {
                OVER_BUDGET
            } else {
                "call"
            };
            self.log.warn(event, &fields);
        } else {
            self.log.info("call", &fields);
        }
    }

    pub fn mail(&self, code: &str, age_ms: f64, to: Option<&str>) {
        let mut fields = LogFields::new();
        fields.insert("code".to_owned(), Value::from(code));
        fields.insert("age".to_owned(), Value::from(js_round(age_ms)));
        self.log.warn("mail-failed", &fields);
        if let (Some(to), Some(incidents)) = (to.filter(|to| !to.is_empty()), &self.incidents) {
            incidents.mail(to, &verb_code(code), age_ms);
        }
    }

    pub fn lease_timeout(&self, age_ms: f64, to: Option<&str>) {
        let mut fields = LogFields::new();
        fields.insert("code".to_owned(), Value::from(MAIL_LEASE_TIMEOUT));
        fields.insert("age".to_owned(), Value::from(js_round(age_ms)));
        self.log.warn("mail-lease", &fields);
        if let (Some(to), Some(incidents)) = (to.filter(|to| !to.is_empty()), &self.incidents) {
            incidents.mail(to, MAIL_LEASE_TIMEOUT, age_ms);
        }
    }

    pub fn hook(&self, pane_id: &str, kind: &str) {
        if let Some(incidents) = &self.incidents {
            incidents.hook(pane_id, true, Some(kind));
        }
    }

    pub fn undelivered(&self, pane_id: &str, pending: &str) {
        if let Some(incidents) = &self.incidents {
            incidents.mail(pane_id, &format!("undelivered-{pending}"), 0.0);
        }
    }

    pub fn wake_not_ready(&self, ms: f64, pane_ids: &[String]) {
        let mut fields = LogFields::new();
        fields.insert("code".to_owned(), Value::from(WAKE_NOT_READY));
        fields.insert("ms".to_owned(), Value::from(js_round(ms)));
        self.log.warn("wake", &fields);
        if let Some(incidents) = &self.incidents {
            for pane_id in pane_ids {
                incidents.wake(pane_id, WAKE_NOT_READY, ms);
            }
        }
    }
}

impl JournalIncidents for IncidentTimeline {
    fn mail(&self, pane_id: &str, code: &str, age_ms: f64) {
        IncidentTimeline::mail(self, pane_id, code, age_ms);
    }

    fn wake(&self, pane_id: &str, code: &str, ms: f64) {
        IncidentTimeline::wake(self, pane_id, code, ms);
    }

    fn hook(&self, pane_id: &str, ok: bool, code: Option<&str>) {
        IncidentTimeline::hook(self, pane_id, ok, code);
    }
}
