use std::path::PathBuf;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use ostia_base::error::io_error;
use ostia_base::js::utf16_len;
use ostia_contract::incident::{INCIDENT_WORDS_MAX, IncidentPeriod};
use parking_lot::Mutex;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Map, Value};

use crate::incident_report::{
    FactsAgent, IncidentFacts, IncidentWords, incident_block, incident_text,
};
use crate::incident_timeline::IncidentTimeline;

const ISSUE_URL: &str = "https://github.com/aurigax-ai/ostia/issues/new";
const UNSEEN: [&str; 4] = [
    "agent-internals",
    "terminal-text",
    "model-output",
    "prompt-text",
];

const COMPONENT: AsciiSet = NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    pub text: String,
    pub count: usize,
}

#[derive(Debug, Clone)]
pub struct IncidentSummary {
    pub reference: String,
    pub trigger: String,
    pub agent: String,
    pub age_ms: i64,
    pub count: usize,
}

#[derive(Debug, Clone)]
pub struct IncidentReportOut {
    pub text: String,
    pub redacted: usize,
}

pub struct IncidentActionsDeps {
    pub incidents: IncidentTimeline,
    pub redact: Arc<dyn Fn(&str) -> BoxFuture<'static, Redacted> + Send + Sync>,
    pub external_of: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub agent_of: Arc<dyn Fn(&str) -> BoxFuture<'static, Option<String>> + Send + Sync>,
    pub settings: Arc<dyn Fn(&str) -> Map<String, Value> + Send + Sync>,
    pub app: Arc<dyn Fn() -> String + Send + Sync>,
    pub platform: String,
    pub open_external: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub pick_save_path: Arc<dyn Fn() -> BoxFuture<'static, Option<PathBuf>> + Send + Sync>,
    pub copy_to_clipboard: Arc<dyn Fn(&str) + Send + Sync>,
}

pub struct IncidentActions {
    deps: IncidentActionsDeps,
    last: Mutex<String>,
}

fn words(raw: &Value) -> Option<IncidentWords> {
    let object = raw.as_object()?;
    let happened = object.get("happened")?.as_str()?;
    let expected = object.get("expected")?.as_str()?;
    if utf16_len(happened) > INCIDENT_WORDS_MAX || utf16_len(expected) > INCIDENT_WORDS_MAX {
        return None;
    }
    Some(IncidentWords {
        happened: happened.to_owned(),
        expected: expected.to_owned(),
    })
}

impl IncidentActions {
    pub fn new(deps: IncidentActionsDeps) -> Self {
        Self {
            deps,
            last: Mutex::new(String::new()),
        }
    }

    pub fn list(&self, period: &str) -> Vec<IncidentSummary> {
        let Some(period) = IncidentPeriod::parse(period) else {
            return Vec::new();
        };
        let mut grouped: Vec<(String, IncidentSummary)> = Vec::new();
        for item in self.deps.incidents.list(period.window_ms()) {
            let key = format!("{}|{}", item.trigger, item.agent);
            match grouped.iter_mut().find(|(known, _)| *known == key) {
                Some((_, have)) => have.count += 1,
                None => grouped.push((
                    key,
                    IncidentSummary {
                        reference: item.reference,
                        trigger: item.trigger,
                        agent: item.agent,
                        age_ms: item.age_ms,
                        count: 1,
                    },
                )),
            }
        }
        grouped.into_iter().map(|(_, summary)| summary).collect()
    }

    pub async fn report(&self, reference: &str, raw: &Value) -> Option<IncidentReportOut> {
        let said = words(raw);
        let external = (self.deps.external_of)(reference).unwrap_or_else(|| reference.to_owned());
        let take = self.deps.incidents.take(&external);
        let (said, take) = (said?, take?);
        let agent = if take.agent == "other" {
            (self.deps.agent_of)(&take.pane_id)
                .await
                .unwrap_or_else(|| "other".to_owned())
        } else {
            take.agent.clone()
        };
        let (happened, expected) = futures_util::future::join(
            (self.deps.redact)(&said.happened),
            (self.deps.redact)(&said.expected),
        )
        .await;
        let totals = self.deps.incidents.totals();
        let settings = (self.deps.settings)(&agent);
        let facts = IncidentFacts {
            app: (self.deps.app)(),
            platform: self.deps.platform.clone(),
            agent: FactsAgent {
                kind: agent,
                version: None,
            },
            settings,
            counts: totals.counts,
            since_min: totals.since_min,
            unseen: UNSEEN.map(str::to_owned).to_vec(),
        };
        let block = incident_block(&take, &facts).ok()?;
        let text = incident_text(
            &block,
            &IncidentWords {
                happened: happened.text,
                expected: expected.text,
            },
        );
        self.last.lock().clone_from(&text);
        Some(IncidentReportOut {
            text,
            redacted: happened.count + expected.count,
        })
    }

    pub async fn save(&self) -> ostia_base::Result<bool> {
        let text = self.last.lock().clone();
        if text.is_empty() {
            return Ok(false);
        }
        let Some(path) = (self.deps.pick_save_path)().await else {
            return Ok(false);
        };
        std::fs::write(&path, text).map_err(io_error(&path))?;
        Ok(true)
    }

    pub fn open_issue(&self) -> bool {
        let text = self.last.lock().clone();
        if text.is_empty() {
            return false;
        }
        (self.deps.copy_to_clipboard)(&text);
        let title = utf8_percent_encode("Agent stalled", &COMPONENT);
        let body = utf8_percent_encode(
            "Paste the report here (it is on your clipboard).",
            &COMPONENT,
        );
        (self.deps.open_external)(&format!("{ISSUE_URL}?title={title}&body={body}"))
    }

    pub fn clear(&self) -> bool {
        self.deps.incidents.clear();
        self.last.lock().clear();
        true
    }
}
