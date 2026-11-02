use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use ostia_base::PRODUCT_NAME;
use ostia_base::js::static_regex;
use ostia_base::json_store::{SaveOptions, save_json};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Number, Value};
use tokio::runtime::Handle;
use tokio::task::AbortHandle;

use crate::app_log::LogFields;
use crate::privacy_telemetry::{
    InstallContext, TELEMETRY_BATCH_MAX, TELEMETRY_QUEUE_MAX, TELEMETRY_SEND_ATTEMPTS,
    TELEMETRY_SENT_MAX, TelemetryCategory, TelemetryEndpoint, TelemetrySettings, build_batch,
    is_usage_report, without_categories,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

static INSTALL_ID: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9a-f-]{36}$"));

pub type LogSink = Arc<dyn Fn(&str, &LogFields) + Send + Sync>;

pub fn new_install_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone)]
pub struct Queued {
    pub report: Value,
    pub attempts: Number,
}

impl Queued {
    fn attempts_value(&self) -> f64 {
        self.attempts.as_f64().unwrap_or(0.0)
    }

    fn with_next_attempt(&self) -> Self {
        let next = match self.attempts.as_i64() {
            Some(count) => Number::from(count.saturating_add(1)),
            None => {
                Number::from_f64(self.attempts_value() + 1.0).unwrap_or_else(|| Number::from(0))
            }
        };
        Self {
            report: self.report.clone(),
            attempts: next,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredTelemetry {
    pub install_id: String,
    pub asked: bool,
    pub answered_at: Option<String>,
    pub seen: Vec<TelemetryCategory>,
    pub queue: Vec<Queued>,
    pub sent: Vec<Value>,
}

impl StoredTelemetry {
    fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "installId".to_owned(),
            Value::from(self.install_id.as_str()),
        );
        out.insert("asked".to_owned(), Value::Bool(self.asked));
        out.insert(
            "answeredAt".to_owned(),
            self.answered_at.as_deref().map_or(Value::Null, Value::from),
        );
        out.insert(
            "seen".to_owned(),
            Value::Array(
                self.seen
                    .iter()
                    .map(|category| Value::from(category.as_str()))
                    .collect(),
            ),
        );
        out.insert(
            "queue".to_owned(),
            Value::Array(
                self.queue
                    .iter()
                    .map(|queued| {
                        let mut entry = Map::new();
                        entry.insert("report".to_owned(), queued.report.clone());
                        entry.insert(
                            "attempts".to_owned(),
                            Value::Number(queued.attempts.clone()),
                        );
                        Value::Object(entry)
                    })
                    .collect(),
            ),
        );
        out.insert("sent".to_owned(), Value::Array(self.sent.clone()));
        Value::Object(out)
    }
}

fn has_string_uuid(report: &Value) -> bool {
    report.get("uuid").is_some_and(Value::is_string)
}

fn last_of<T>(mut items: Vec<T>, max: usize) -> Vec<T> {
    let excess = items.len().saturating_sub(max);
    items.drain(..excess);
    items
}

pub fn parse_stored(raw: &Value) -> StoredTelemetry {
    let install_id = raw
        .get("installId")
        .and_then(Value::as_str)
        .filter(|id| INSTALL_ID.is_match(id))
        .map_or_else(new_install_id, str::to_owned);
    let queue: Vec<Queued> = raw
        .get("queue")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let attempts = entry.get("attempts")?.as_number()?.clone();
                    let report = entry.get("report")?;
                    has_string_uuid(report).then(|| Queued {
                        report: report.clone(),
                        attempts,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let sent: Vec<Value> = raw
        .get("sent")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|report| has_string_uuid(report))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let seen = raw
        .get("seen")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| TelemetryCategory::parse(entry.as_str()?))
                .collect()
        })
        .unwrap_or_default();
    StoredTelemetry {
        install_id,
        asked: raw.get("asked") == Some(&Value::Bool(true)),
        answered_at: raw
            .get("answeredAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
        seen,
        queue: last_of(queue, TELEMETRY_QUEUE_MAX),
        sent: last_of(sent, TELEMETRY_SENT_MAX),
    }
}

#[derive(Debug, Clone)]
pub struct PostRequest {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

pub trait PostTransport: Send + Sync {
    fn post(&self, request: PostRequest) -> BoxFuture<'_, Option<u16>>;
}

struct HttpTransport {
    client: Option<reqwest::Client>,
}

impl PostTransport for HttpTransport {
    fn post(&self, request: PostRequest) -> BoxFuture<'_, Option<u16>> {
        Box::pin(async move {
            let client = self.client.as_ref()?;
            let mut builder = client.post(&request.url).body(request.body);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            let response = builder.send().await.ok()?;
            Some(response.status().as_u16())
        })
    }
}

pub fn http_transport() -> Arc<dyn PostTransport> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .ok();
    Arc::new(HttpTransport { client })
}

pub struct TelemetryQueueDeps {
    pub file: PathBuf,
    pub endpoint: Option<TelemetryEndpoint>,
    pub context: Arc<dyn Fn() -> InstallContext + Send + Sync>,
    pub settings: Arc<dyn Fn() -> TelemetrySettings + Send + Sync>,
    pub transport: Arc<dyn PostTransport>,
    pub log: Option<LogSink>,
    pub flush_delay: Duration,
    pub retry_delay: Duration,
}

struct Timer {
    id: u64,
    handle: AbortHandle,
}

struct QueueState {
    stored: StoredTelemetry,
    flush_timer: Option<Timer>,
    retry_timer: Option<Timer>,
    sending: Option<Shared<BoxFuture<'static, ()>>>,
    shut_down: bool,
    timer_seq: u64,
}

struct QueueInner {
    deps: TelemetryQueueDeps,
    state: Mutex<QueueState>,
}

#[derive(Clone)]
pub struct TelemetryQueue {
    inner: Arc<QueueInner>,
}

impl QueueInner {
    fn log(&self, event: &str, fields: &LogFields) {
        if let Some(sink) = &self.deps.log {
            sink(event, fields);
        }
    }

    fn log_unsaved(&self) {
        self.log("telemetry-unsaved", &LogFields::new());
    }

    fn save_failed(&self, state: &QueueState) -> bool {
        save_json(
            &self.deps.file,
            &state.stored.to_value(),
            SaveOptions::SECURE,
        )
        .is_err()
    }

    fn timer_slot(state: &mut QueueState, retry: bool) -> &mut Option<Timer> {
        if retry {
            &mut state.retry_timer
        } else {
            &mut state.flush_timer
        }
    }

    fn arm_timer(self: &Arc<Self>, state: &mut QueueState, retry: bool, delay: Duration) {
        let Ok(runtime) = Handle::try_current() else {
            return;
        };
        state.timer_seq += 1;
        let id = state.timer_seq;
        let sleep = tokio::time::sleep(delay);
        let weak: Weak<Self> = Arc::downgrade(self);
        let handle = runtime.spawn(async move {
            sleep.await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            {
                let mut state = inner.state.lock();
                let slot = Self::timer_slot(&mut state, retry);
                if slot.as_ref().map(|timer| timer.id) != Some(id) {
                    return;
                }
                *slot = None;
            }
            inner.flush().await;
        });
        *Self::timer_slot(state, retry) = Some(Timer {
            id,
            handle: handle.abort_handle(),
        });
    }

    fn schedule_flush(self: &Arc<Self>, state: &mut QueueState, delay: Duration) {
        if self.deps.endpoint.is_none() || state.flush_timer.is_some() || state.shut_down {
            return;
        }
        self.arm_timer(state, false, delay);
    }

    fn drop_kind_locked(&self, state: &mut QueueState, settings: &TelemetrySettings) -> bool {
        let mut kept: Vec<Queued> = Vec::new();
        let mut replaced = false;
        for queued in &state.stored.queue {
            if !is_usage_report(&queued.report) {
                if settings.get(TelemetryCategory::Errors) {
                    kept.push(queued.clone());
                }
                continue;
            }
            if let Some(trimmed) = without_categories(&queued.report, settings) {
                replaced = true;
                kept.push(Queued {
                    report: trimmed,
                    attempts: queued.attempts.clone(),
                });
            }
        }
        let changed = kept.len() != state.stored.queue.len() || replaced;
        if !changed {
            return false;
        }
        state.stored.queue = kept;
        self.save_failed(state)
    }

    fn flush(self: &Arc<Self>) -> BoxFuture<'static, ()> {
        let settings = (self.deps.settings)();
        let client = format!("{PRODUCT_NAME}/{}", (self.deps.context)().app_version);
        let mut state = self.state.lock();
        if let Some(sending) = &state.sending {
            return sending.clone().boxed();
        }
        let Some(endpoint) = self.deps.endpoint.clone() else {
            return futures_util::future::ready(()).boxed();
        };
        let unsaved = self.drop_kind_locked(&mut state, &settings);
        let batch: Vec<Queued> = state
            .stored
            .queue
            .iter()
            .take(TELEMETRY_BATCH_MAX)
            .cloned()
            .collect();
        if batch.is_empty() {
            drop(state);
            if unsaved {
                self.log_unsaved();
            }
            return futures_util::future::ready(()).boxed();
        }
        let body = build_batch(
            &batch
                .iter()
                .map(|queued| queued.report.clone())
                .collect::<Vec<_>>(),
            &endpoint.api_key,
        );
        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".to_owned(), "application/json".to_owned());
        headers.insert("User-Agent".to_owned(), client);
        let request = PostRequest {
            url: endpoint.url,
            headers,
            body,
        };
        let inner = self.clone();
        let work: BoxFuture<'static, ()> = Box::pin(async move {
            let status = inner.deps.transport.post(request).await;
            let sent = status.is_some_and(|code| (200..300).contains(&code));
            inner.finish_send(&batch, sent);
            inner.state.lock().sending = None;
        });
        let started: BoxFuture<'static, ()> = match Handle::try_current() {
            Ok(runtime) => {
                let join = runtime.spawn(work);
                Box::pin(async move {
                    let _ = join.await;
                })
            }
            Err(_) => work,
        };
        let shared = started.shared();
        state.sending = Some(shared.clone());
        drop(state);
        if unsaved {
            self.log_unsaved();
        }
        shared.boxed()
    }

    fn finish_send(self: &Arc<Self>, batch: &[Queued], sent: bool) {
        let ids: HashSet<String> = batch
            .iter()
            .filter_map(|queued| queued.report.get("uuid")?.as_str().map(str::to_owned))
            .collect();
        let in_batch = |queued: &Queued| {
            queued
                .report
                .get("uuid")
                .and_then(Value::as_str)
                .is_some_and(|id| ids.contains(id))
        };
        let mut fields = LogFields::new();
        fields.insert("reports".to_owned(), Value::from(batch.len()));
        let unsaved;
        {
            let mut state = self.state.lock();
            if sent {
                state.stored.queue.retain(|queued| !in_batch(queued));
                let mut all = std::mem::take(&mut state.stored.sent);
                all.extend(batch.iter().map(|queued| queued.report.clone()));
                state.stored.sent = last_of(all, TELEMETRY_SENT_MAX);
                unsaved = self.save_failed(&state);
                if !state.stored.queue.is_empty() {
                    self.schedule_flush(&mut state, Duration::ZERO);
                }
            } else {
                let bumped: Vec<Queued> = state
                    .stored
                    .queue
                    .iter()
                    .map(|queued| {
                        if in_batch(queued) {
                            queued.with_next_attempt()
                        } else {
                            queued.clone()
                        }
                    })
                    .filter(|queued| queued.attempts_value() < TELEMETRY_SEND_ATTEMPTS as f64)
                    .collect();
                state.stored.queue = bumped;
                unsaved = self.save_failed(&state);
                if !state.stored.queue.is_empty() && state.retry_timer.is_none() && !state.shut_down
                {
                    self.arm_timer(&mut state, true, self.deps.retry_delay);
                }
            }
        }
        self.log(
            if sent {
                "telemetry-sent"
            } else {
                "telemetry-send-failed"
            },
            &fields,
        );
        if unsaved {
            self.log_unsaved();
        }
    }
}

impl TelemetryQueue {
    pub fn new(deps: TelemetryQueueDeps, stored: StoredTelemetry) -> Self {
        Self {
            inner: Arc::new(QueueInner {
                deps,
                state: Mutex::new(QueueState {
                    stored,
                    flush_timer: None,
                    retry_timer: None,
                    sending: None,
                    shut_down: false,
                    timer_seq: 0,
                }),
            }),
        }
    }

    pub fn has_endpoint(&self) -> bool {
        self.inner.deps.endpoint.is_some()
    }

    pub fn read<R>(&self, read: impl FnOnce(&StoredTelemetry) -> R) -> R {
        read(&self.inner.state.lock().stored)
    }

    pub fn update(&self, change: impl FnOnce(&mut StoredTelemetry) -> bool) {
        let unsaved = {
            let mut state = self.inner.state.lock();
            change(&mut state.stored) && self.inner.save_failed(&state)
        };
        if unsaved {
            self.inner.log_unsaved();
        }
    }

    pub fn enqueue(&self, report: Value) {
        let unsaved = {
            let mut state = self.inner.state.lock();
            state.stored.queue.push(Queued {
                report,
                attempts: Number::from(0),
            });
            let excess = state.stored.queue.len().saturating_sub(TELEMETRY_QUEUE_MAX);
            state.stored.queue.drain(..excess);
            let unsaved = self.inner.save_failed(&state);
            self.inner
                .schedule_flush(&mut state, self.inner.deps.flush_delay);
            unsaved
        };
        if unsaved {
            self.inner.log_unsaved();
        }
    }

    pub fn drop_kind(&self) {
        let settings = (self.inner.deps.settings)();
        let unsaved = {
            let mut state = self.inner.state.lock();
            self.inner.drop_kind_locked(&mut state, &settings)
        };
        if unsaved {
            self.inner.log_unsaved();
        }
    }

    pub fn flush(&self) -> BoxFuture<'static, ()> {
        self.inner.flush()
    }

    pub fn queue_is_empty(&self) -> bool {
        self.inner.state.lock().stored.queue.is_empty()
    }

    pub fn begin_shutdown(&self) -> bool {
        let mut state = self.inner.state.lock();
        if state.shut_down {
            return false;
        }
        state.shut_down = true;
        for timer in [state.flush_timer.as_ref(), state.retry_timer.as_ref()]
            .into_iter()
            .flatten()
        {
            timer.handle.abort();
        }
        true
    }
}
