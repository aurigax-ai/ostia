use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared, ready};
use ostia_base::clock::Clock;
use ostia_base::json_store::{SaveOptions, load_json, save_json_async};
use ostia_base::{Error, EventHub};
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::bus_text::bus_preview;
use crate::iso_time::{format_iso, parse_iso};

pub const INBOX_MAX: usize = 200;
pub const MAIL_TTL_MS: i64 = 24 * 60 * 60 * 1000;
pub const LEASE_MS: i64 = 120_000;
pub const HISTORY_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const HISTORY_PER_SENDER: usize = 500;
pub const MAIL_PANE_CLOSED: &str = "pane-closed";
const SENT_LISTED: usize = 50;
const EVENT_LINES_MAX: usize = 20;
const FAILED_SHOWN_MAX: usize = 5;
const OSTIA_SENDER: &str = "ostia";

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailKind {
    Message,
    Event,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailState {
    Queued,
    Leased,
    Delivered,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MailPending {
    Working,
    IdleNoWake,
    IdleWillWake,
    Draft,
    RateLimited,
    Hibernated,
    HooksOff,
    AgentPane,
    NoAgent,
    RemoteOffline,
}

impl MailPending {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::IdleNoWake => "idle-no-wake",
            Self::IdleWillWake => "idle-will-wake",
            Self::Draft => "draft",
            Self::RateLimited => "rate-limited",
            Self::Hibernated => "hibernated",
            Self::HooksOff => "hooks-off",
            Self::AgentPane => "agent-pane",
            Self::NoAgent => "no-agent",
            Self::RemoteOffline => "remote-offline",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailVia {
    Prompt,
    Start,
    Read,
    Turn,
    Remote,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mail {
    pub id: String,
    pub kind: MailKind,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub preview: String,
    pub ts: String,
    pub state: MailState,
    #[serde(skip_serializing_if = "is_false")]
    pub task: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub quiet: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub wakes: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<MailPending>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leased_until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<MailVia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_at: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub dismissed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HandoffState {
    Submitted,
    Claimed,
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub id: String,
    pub from: String,
    pub to: String,
    pub task: String,
    pub summary: String,
    pub state: HandoffState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<HandoffContext>,
    pub ts: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Watch {
    pub subscriber: String,
    pub watched: String,
    pub until: Vec<String>,
}

#[derive(Clone, Debug, Default)]
struct Wakes(Vec<(String, Vec<i64>)>);

impl Serialize for Wakes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(id, times)| (id, times)))
    }
}

#[derive(Clone, Debug, Default, Serialize)]
struct BusData {
    mail: Vec<Mail>,
    handoffs: Vec<Handoff>,
    watches: Vec<Watch>,
    wakes: Wakes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BusKind {
    Task,
    Message,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BusPhase {
    Queued,
    Delivered,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BusObservation {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: BusKind,
    pub phase: BusPhase,
}

pub type BusObserver = Arc<dyn Fn(BusObservation) + Send + Sync>;
pub type MailPick = Arc<dyn Fn(&Mail) -> bool + Send + Sync>;

pub trait MailJournal: Send + Sync {
    fn mail(&self, reason: &str, age_ms: i64, to: &str);
    fn lease_timeout(&self, age_ms: i64, to: &str);
}

#[derive(Clone, Debug)]
pub struct MailDraft {
    pub id: Option<String>,
    pub route: Option<String>,
    pub origin: Option<String>,
    pub from: String,
    pub to: String,
    pub text: String,
    pub task: bool,
    pub quiet: bool,
    pub wakes: bool,
    pub kind: Option<MailKind>,
}

impl MailDraft {
    pub fn new(from: impl Into<String>, to: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            id: None,
            route: None,
            origin: None,
            from: from.into(),
            to: to.into(),
            text: text.into(),
            task: false,
            quiet: false,
            wakes: false,
            kind: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RemoteMail {
    pub id: String,
    pub origin: String,
    pub from: String,
    pub to: String,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiveOutcome {
    Stored,
    Full,
}

pub type ReceiveResult = Result<ReceiveOutcome, Arc<Error>>;
pub type Receiving = Shared<BoxFuture<'static, ReceiveResult>>;

#[derive(Clone, Debug)]
pub struct HandedMail {
    pub lease: String,
    pub messages: Vec<Mail>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MailViewState {
    Queued,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MailView {
    pub id: String,
    pub state: MailViewState,
    pub from: String,
    pub to: String,
    pub ts: String,
    pub pending: Option<MailPending>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MailCounts {
    pub queued: usize,
    pub failed: usize,
    pub sent_queued: usize,
    pub sent_failed: usize,
    pub oldest_queued_ms: Option<i64>,
    pub last_failure: Option<String>,
}

enum Effect {
    Observe(BusObservation),
    Journal {
        reason: String,
        age_ms: i64,
        to: String,
    },
    LeaseTimeout {
        age_ms: i64,
        to: String,
    },
}

fn text_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key)?.as_str().map(str::to_owned)
}

fn enum_field<T: DeserializeOwned>(object: &Map<String, Value>, key: &str) -> Option<T> {
    serde_json::from_value(object.get(key)?.clone()).ok()
}

fn flag(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key) == Some(&Value::Bool(true))
}

fn parse_mail(raw: &Value) -> Option<Mail> {
    let object = raw.as_object()?;
    let kind = match object.get("kind") {
        None => MailKind::Message,
        Some(kind) => serde_json::from_value(kind.clone()).ok()?,
    };
    Some(Mail {
        id: text_field(object, "id")?,
        kind,
        from: text_field(object, "from")?,
        to: text_field(object, "to")?,
        text: text_field(object, "text"),
        preview: text_field(object, "preview").unwrap_or_default(),
        ts: text_field(object, "ts")?,
        state: enum_field(object, "state")?,
        task: flag(object, "task"),
        quiet: flag(object, "quiet"),
        wakes: flag(object, "wakes"),
        route: text_field(object, "route"),
        origin: text_field(object, "origin"),
        pending: enum_field(object, "pending"),
        lease: text_field(object, "lease"),
        leased_until: object.get("leasedUntil").and_then(Value::as_i64),
        via: enum_field(object, "via"),
        delivered_at: text_field(object, "deliveredAt"),
        reason: text_field(object, "reason"),
        failed_at: text_field(object, "failedAt"),
        dismissed: flag(object, "dismissed"),
    })
}

fn string_list(raw: &Value) -> Option<Vec<String>> {
    Some(
        raw.as_array()?
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
    )
}

fn parse_handoff(raw: &Value) -> Option<Handoff> {
    let object = raw.as_object()?;
    let context = object
        .get("context")
        .and_then(Value::as_object)
        .map(|context| HandoffContext {
            artifacts: context.get("artifacts").and_then(string_list),
            work_dir: text_field(context, "workDir"),
        });
    Some(Handoff {
        id: text_field(object, "id")?,
        from: text_field(object, "from")?,
        to: text_field(object, "to")?,
        task: text_field(object, "task")?,
        summary: text_field(object, "summary")?,
        state: enum_field(object, "state")?,
        context,
        ts: text_field(object, "ts")?,
        updated_at: text_field(object, "updatedAt")?,
    })
}

fn parse_watch(raw: &Value) -> Option<Watch> {
    let object = raw.as_object()?;
    Some(Watch {
        subscriber: text_field(object, "subscriber")?,
        watched: text_field(object, "watched")?,
        until: string_list(object.get("until")?)?,
    })
}

fn parse_list<T>(stored: &Map<String, Value>, key: &str, parse: fn(&Value) -> Option<T>) -> Vec<T> {
    stored
        .get(key)
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |items| items.iter().filter_map(parse).collect())
}

fn parse_wakes(raw: Option<&Value>) -> Wakes {
    Wakes(
        raw.and_then(Value::as_object)
            .map_or_else(Vec::new, |wakes| {
                wakes
                    .iter()
                    .filter_map(|(id, times)| {
                        let times = times.as_array()?.iter().filter_map(Value::as_i64).collect();
                        Some((id.clone(), times))
                    })
                    .collect()
            }),
    )
}

fn read_data(file: &Path) -> BusData {
    let Some(Value::Object(stored)) = load_json(file) else {
        return BusData::default();
    };
    BusData {
        mail: parse_list(&stored, "mail", parse_mail),
        handoffs: parse_list(&stored, "handoffs", parse_handoff),
        watches: parse_list(&stored, "watches", parse_watch),
        wakes: parse_wakes(stored.get("wakes")),
    }
}

fn undelivered(mail: &Mail) -> bool {
    matches!(mail.state, MailState::Queued | MailState::Leased)
}

fn mail_expired(pending: Option<MailPending>) -> String {
    format!("expired:{}", pending.map_or("queued", MailPending::as_str))
}

fn age_since(ts: &str, now: i64) -> i64 {
    parse_iso(ts).map_or(0, |at| now - at)
}

fn observe(effects: &mut Vec<Effect>, mail: &Mail, phase: BusPhase) {
    if mail.quiet || mail.kind == MailKind::Event {
        return;
    }
    effects.push(Effect::Observe(BusObservation {
        id: mail.id.clone(),
        from: mail.from.clone(),
        to: mail.to.clone(),
        kind: if mail.task {
            BusKind::Task
        } else {
            BusKind::Message
        },
        phase,
    }));
}

fn settle(effects: &mut Vec<Effect>, mail: &mut Mail, state: MailState) {
    mail.state = state;
    mail.text = None;
    mail.lease = None;
    mail.leased_until = None;
    observe(
        effects,
        mail,
        if state == MailState::Delivered {
            BusPhase::Delivered
        } else {
            BusPhase::Failed
        },
    );
}

fn deliver_mail(effects: &mut Vec<Effect>, mail: &mut Mail, via: MailVia, at_ms: i64) {
    mail.via = Some(via);
    mail.delivered_at = Some(format_iso(at_ms));
    settle(effects, mail, MailState::Delivered);
}

fn fail_mail(effects: &mut Vec<Effect>, mail: &mut Mail, reason: &str, at_ms: i64) {
    mail.reason = Some(reason.to_owned());
    mail.failed_at = Some(format_iso(at_ms));
    effects.push(Effect::Journal {
        reason: reason.to_owned(),
        age_ms: age_since(&mail.ts, at_ms),
        to: mail.to.clone(),
    });
    settle(effects, mail, MailState::Failed);
}

fn requeue(mail: &mut Mail) {
    mail.state = MailState::Queued;
    mail.lease = None;
    mail.leased_until = None;
}

struct WaiterEntry {
    id: u64,
    pick: Option<MailPick>,
    sender: oneshot::Sender<HandedMail>,
}

impl WaiterEntry {
    fn priority(&self) -> bool {
        self.pick.is_some()
    }

    fn accepts(&self, mail: &Mail) -> bool {
        self.pick.as_ref().is_none_or(|pick| pick(mail))
    }
}

enum Prepared {
    Stored,
    Full,
    Write {
        mail: Box<Mail>,
        path: PathBuf,
        value: Value,
    },
}

struct State {
    path: PathBuf,
    clock: Clock,
    data: BusData,
    loaded: bool,
    waiters: HashMap<String, Vec<WaiterEntry>>,
    next_waiter: u64,
    observer: Option<BusObserver>,
    journal: Option<Arc<dyn MailJournal>>,
    effects: Vec<Effect>,
    queued: EventHub<Mail>,
    dirty: bool,
    touched: bool,
    inflight: bool,
    change_queued: bool,
}

impl State {
    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn ensure_loaded(&mut self) {
        if !self.loaded {
            self.data = read_data(&self.path);
            self.loaded = true;
        }
    }

    fn mark_dirty(&mut self) {
        self.dirty = true;
        self.touched = true;
    }

    fn prune_history(&mut self, now: i64) -> bool {
        let mail = std::mem::take(&mut self.data.mail);
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut kept = Vec::with_capacity(mail.len());
        let mut changed = false;
        for item in mail.into_iter().rev() {
            if !undelivered(&item) {
                let at = parse_iso(
                    item.delivered_at
                        .as_deref()
                        .or(item.failed_at.as_deref())
                        .unwrap_or(&item.ts),
                );
                let count = seen.entry(item.from.clone()).or_insert(0);
                *count += 1;
                if at.is_some_and(|at| now - at > HISTORY_MS) || *count > HISTORY_PER_SENDER {
                    changed = true;
                    continue;
                }
            }
            kept.push(item);
        }
        kept.reverse();
        self.data.mail = kept;
        changed
    }

    fn sweep_at(&mut self, now: i64) {
        let mut changed = false;
        for mail in &mut self.data.mail {
            if mail.state == MailState::Leased && mail.leased_until.unwrap_or(0) <= now {
                self.effects.push(Effect::LeaseTimeout {
                    age_ms: age_since(&mail.ts, now),
                    to: mail.to.clone(),
                });
                requeue(mail);
                changed = true;
            }
            if mail.state == MailState::Queued
                && parse_iso(&mail.ts).is_some_and(|at| at + MAIL_TTL_MS <= now)
            {
                let reason = mail_expired(mail.pending);
                fail_mail(&mut self.effects, mail, &reason, now);
                changed = true;
            }
        }
        if self.prune_history(now) || changed {
            self.mark_dirty();
        }
    }

    fn sweep(&mut self) {
        let now = self.now();
        self.sweep_at(now);
    }

    fn inbox_full(&mut self, to: &str) -> bool {
        self.sweep();
        self.data
            .mail
            .iter()
            .filter(|mail| mail.to == to && undelivered(mail))
            .count()
            >= INBOX_MAX
    }

    fn new_mail(&self, draft: MailDraft) -> Mail {
        Mail {
            id: draft.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            kind: draft.kind.unwrap_or(MailKind::Message),
            from: draft.from,
            to: draft.to,
            preview: bus_preview(&draft.text),
            text: Some(draft.text),
            ts: format_iso(self.now()),
            state: MailState::Queued,
            task: draft.task,
            quiet: draft.quiet,
            wakes: draft.wakes,
            route: draft.route.filter(|route| !route.is_empty()),
            origin: draft.origin.filter(|origin| !origin.is_empty()),
            pending: None,
            lease: None,
            leased_until: None,
            via: None,
            delivered_at: None,
            reason: None,
            failed_at: None,
            dismissed: false,
        }
    }

    fn lease(
        &mut self,
        to: &str,
        via: MailVia,
        pick: &dyn Fn(&Mail) -> bool,
    ) -> Option<HandedMail> {
        self.sweep();
        let lease = Uuid::new_v4().to_string();
        let until = self.now() + LEASE_MS;
        let mut messages = Vec::new();
        for mail in &mut self.data.mail {
            if mail.to != to || mail.state != MailState::Queued || !pick(mail) {
                continue;
            }
            mail.state = MailState::Leased;
            mail.lease = Some(lease.clone());
            mail.leased_until = Some(until);
            mail.via = Some(via);
            messages.push(mail.clone());
        }
        if messages.is_empty() {
            return None;
        }
        self.mark_dirty();
        Some(HandedMail { lease, messages })
    }

    fn release(&mut self, to: &str, lease: &str) {
        let mut changed = false;
        for mail in &mut self.data.mail {
            if mail.to != to
                || mail.state != MailState::Leased
                || mail.lease.as_deref() != Some(lease)
            {
                continue;
            }
            requeue(mail);
            changed = true;
        }
        if changed {
            self.mark_dirty();
        }
    }

    fn place(&mut self, mail: Mail) -> Mail {
        let to = mail.to.clone();
        let id = mail.id.clone();
        let mut placed = mail.clone();
        observe(&mut self.effects, &mail, BusPhase::Queued);
        self.data.mail.push(mail);
        let chosen = self.waiters.get(&to).and_then(|parked| {
            let waiting = self.data.mail.last()?;
            let matching: Vec<usize> = parked
                .iter()
                .enumerate()
                .filter(|(_, waiter)| waiter.accepts(waiting))
                .map(|(index, _)| index)
                .collect();
            matching
                .iter()
                .copied()
                .find(|index| parked[*index].priority())
                .or_else(|| matching.first().copied())
        });
        if let Some(index) = chosen
            && let Some(parked) = self.waiters.get_mut(&to)
        {
            let waiter = parked.remove(index);
            if parked.is_empty() {
                self.waiters.remove(&to);
            }
            let handed = self.lease(&to, MailVia::Read, &|item: &Mail| item.id == id);
            if let Some(handed) = handed {
                if let Some(leased) = handed.messages.first() {
                    placed.clone_from(leased);
                }
                if let Err(handed) = waiter.sender.send(handed) {
                    self.release(&to, &handed.lease);
                }
            }
        }
        self.mark_dirty();
        if !placed.quiet && placed.state == MailState::Queued {
            self.queued.emit(placed.clone());
        }
        placed
    }

    fn enqueue(&mut self, draft: MailDraft) -> Mail {
        self.sweep();
        let mail = self.new_mail(draft);
        self.place(mail)
    }

    fn prepare_receive(&mut self, draft: &RemoteMail) -> Result<Prepared, Error> {
        if self.data.mail.iter().any(|mail| {
            mail.origin.as_deref() == Some(draft.origin.as_str()) && mail.id == draft.id
        }) {
            return Ok(Prepared::Stored);
        }
        if self.inbox_full(&draft.to) {
            return Ok(Prepared::Full);
        }
        let mail = self.new_mail(MailDraft {
            id: Some(draft.id.clone()),
            origin: Some(draft.origin.clone()),
            ..MailDraft::new(&draft.from, &draft.to, &draft.text)
        });
        self.data.mail.push(mail.clone());
        let value = serde_json::to_value(&self.data);
        self.data.mail.pop();
        let value = value.map_err(|source| Error::Json {
            path: self.path.clone(),
            source,
        })?;
        Ok(Prepared::Write {
            mail: Box::new(mail),
            path: self.path.clone(),
            value,
        })
    }

    fn fail_where(&mut self, reason: &str, matches: impl Fn(&Mail) -> bool) {
        let at = self.now();
        let mut changed = false;
        for mail in &mut self.data.mail {
            if matches(mail) {
                fail_mail(&mut self.effects, mail, reason, at);
                changed = true;
            }
        }
        if changed {
            self.mark_dirty();
        }
    }

    fn settle_on_route(&mut self, route: &str, id: &str, outcome: Result<MailVia, &str>) -> bool {
        let at = self.now();
        let Some(mail) = self
            .data
            .mail
            .iter_mut()
            .find(|item| item.id == id && item.route.as_deref() == Some(route))
        else {
            return false;
        };
        if mail.state == MailState::Queued {
            match outcome {
                Ok(via) => deliver_mail(&mut self.effects, mail, via, at),
                Err(reason) => fail_mail(&mut self.effects, mail, reason, at),
            }
            self.mark_dirty();
        }
        true
    }
}

struct Inner {
    state: Mutex<State>,
    busy: watch::Sender<bool>,
    changed: EventHub<()>,
    receiving: Mutex<HashMap<String, Receiving>>,
}

async fn drain(inner: Arc<Inner>) {
    loop {
        let job = {
            let mut state = inner.state.lock();
            if !state.dirty {
                state.inflight = false;
                inner.busy.send_replace(false);
                return;
            }
            state.dirty = false;
            state.ensure_loaded();
            serde_json::to_value(&state.data)
                .ok()
                .map(|value| (state.path.clone(), value))
        };
        if let Some((path, value)) = job {
            let _ = save_json_async(&path, &value, SaveOptions::SECURE).await;
        }
    }
}

fn announce_change(inner: &Inner) {
    inner.state.lock().change_queued = false;
    inner.changed.emit(());
}

pub struct Waiter {
    inner: Arc<Inner>,
    to: String,
    id: u64,
    receiver: oneshot::Receiver<HandedMail>,
}

impl Waiter {
    pub fn try_recv(&mut self) -> Option<HandedMail> {
        self.receiver.try_recv().ok()
    }

    pub async fn recv(&mut self) -> Option<HandedMail> {
        (&mut self.receiver).await.ok()
    }

    pub fn cancel(&mut self) {
        let mut state = self.inner.state.lock();
        if let Some(parked) = state.waiters.get_mut(&self.to) {
            parked.retain(|waiter| waiter.id != self.id);
            if parked.is_empty() {
                state.waiters.remove(&self.to);
            }
        }
    }
}

impl Drop for Waiter {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Clone)]
pub struct BusStore {
    inner: Arc<Inner>,
}

impl BusStore {
    pub fn new(path: PathBuf, clock: Clock) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    path,
                    clock,
                    data: BusData::default(),
                    loaded: false,
                    waiters: HashMap::new(),
                    next_waiter: 0,
                    observer: None,
                    journal: None,
                    effects: Vec::new(),
                    queued: EventHub::default(),
                    dirty: false,
                    touched: false,
                    inflight: false,
                    change_queued: false,
                }),
                busy: watch::channel(false).0,
                changed: EventHub::default(),
                receiving: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn schedule(&self, state: &mut State) {
        if !state.touched {
            return;
        }
        state.touched = false;
        if !state.inflight {
            state.inflight = true;
            self.inner.busy.send_replace(true);
            tokio::spawn(drain(Arc::clone(&self.inner)));
        }
        if !state.change_queued {
            state.change_queued = true;
            let inner = Arc::clone(&self.inner);
            tokio::spawn(async move { announce_change(&inner) });
        }
    }

    fn with<R>(&self, work: impl FnOnce(&mut State) -> R) -> R {
        let (result, effects, observer, journal) = {
            let mut state = self.inner.state.lock();
            state.ensure_loaded();
            let result = work(&mut state);
            self.schedule(&mut state);
            (
                result,
                std::mem::take(&mut state.effects),
                state.observer.clone(),
                state.journal.clone(),
            )
        };
        for effect in effects {
            match effect {
                Effect::Observe(observation) => {
                    if let Some(observer) = &observer {
                        observer(observation);
                    }
                }
                Effect::Journal { reason, age_ms, to } => {
                    if let Some(journal) = &journal {
                        journal.mail(&reason, age_ms, &to);
                    }
                }
                Effect::LeaseTimeout { age_ms, to } => {
                    if let Some(journal) = &journal {
                        journal.lease_timeout(age_ms, &to);
                    }
                }
            }
        }
        result
    }

    pub fn set_path(&self, path: PathBuf) {
        self.inner.state.lock().path = path;
    }

    pub fn set_observer(&self, observer: Option<BusObserver>) {
        self.inner.state.lock().observer = observer;
    }

    pub fn set_journal(&self, journal: Option<Arc<dyn MailJournal>>) {
        self.inner.state.lock().journal = journal;
    }

    pub fn on_change(&self) -> UnboundedReceiver<()> {
        self.inner.changed.subscribe()
    }

    pub fn on_mail_queued(&self) -> UnboundedReceiver<Mail> {
        self.inner.state.lock().queued.subscribe()
    }

    pub async fn flush(&self) {
        let mut idle = self.inner.busy.subscribe();
        let _ = idle.wait_for(|busy| !*busy).await;
    }

    pub async fn reset(&self) {
        self.flush().await;
        let mut state = self.inner.state.lock();
        state.data = BusData::default();
        state.loaded = false;
        state.waiters.clear();
    }

    pub fn handoffs(&self) -> Vec<Handoff> {
        self.with(|state| state.data.handoffs.clone())
    }

    pub fn receive(&self, draft: RemoteMail) -> Receiving {
        let key = format!("{}\0{}", draft.origin, draft.id);
        let mut running = self.inner.receiving.lock();
        if let Some(existing) = running.get(&key) {
            return existing.clone();
        }
        let prepared = match self.with(|state| state.prepare_receive(&draft)) {
            Ok(prepared) => prepared,
            Err(error) => return ready(Err(Arc::new(error))).boxed().shared(),
        };
        let (mail, path, value) = match prepared {
            Prepared::Stored => return ready(Ok(ReceiveOutcome::Stored)).boxed().shared(),
            Prepared::Full => return ready(Ok(ReceiveOutcome::Full)).boxed().shared(),
            Prepared::Write { mail, path, value } => (mail, path, value),
        };
        let write =
            tokio::spawn(async move { save_json_async(&path, &value, SaveOptions::SECURE).await });
        let store = self.clone();
        let release = key.clone();
        let work: BoxFuture<'static, ReceiveResult> = async move {
            let outcome = store.place_received(write, *mail).await;
            store.inner.receiving.lock().remove(&release);
            outcome
        }
        .boxed();
        let shared = work.shared();
        running.insert(key, shared.clone());
        shared
    }

    async fn place_received(
        &self,
        write: JoinHandle<ostia_base::Result<()>>,
        mail: Mail,
    ) -> ReceiveResult {
        match write.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(Arc::new(error)),
            Err(error) => return Err(Arc::new(Error::Task(error.to_string()))),
        }
        self.with(|state| state.place(mail));
        self.flush().await;
        Ok(ReceiveOutcome::Stored)
    }

    pub fn queued_on_route(&self, route: &str) -> Vec<Mail> {
        self.with(|state| {
            state.sweep();
            state
                .data
                .mail
                .iter()
                .filter(|mail| {
                    mail.route.as_deref() == Some(route) && mail.state == MailState::Queued
                })
                .cloned()
                .collect()
        })
    }

    pub fn failed_on_route(&self, route: &str, since: &str) -> usize {
        self.with(|state| {
            state
                .data
                .mail
                .iter()
                .filter(|mail| {
                    mail.route.as_deref() == Some(route)
                        && mail.state == MailState::Failed
                        && mail.failed_at.as_deref().unwrap_or("") >= since
                })
                .count()
        })
    }

    pub fn stored_on_route(&self, route: &str, id: &str) -> bool {
        self.with(|state| state.settle_on_route(route, id, Ok(MailVia::Remote)))
    }

    pub fn refused_on_route(&self, route: &str, id: &str, reason: &str) -> bool {
        self.with(|state| state.settle_on_route(route, id, Err(reason)))
    }

    pub fn has_mailed(&self, from: &str, to: &str) -> bool {
        self.with(|state| {
            state
                .data
                .mail
                .iter()
                .any(|mail| mail.from == from && mail.to == to)
        })
    }

    pub fn peers_of_route(&self, route: &str) -> Vec<String> {
        let prefix = format!("{route}:");
        self.with(|state| {
            let mut peers: Vec<String> = Vec::new();
            for mail in &state.data.mail {
                let peer = if mail.to.starts_with(&prefix) {
                    &mail.from
                } else if mail.from.starts_with(&prefix) {
                    &mail.to
                } else {
                    continue;
                };
                if !peers.contains(peer) {
                    peers.push(peer.clone());
                }
            }
            peers
        })
    }

    pub fn sweep(&self) {
        self.with(State::sweep);
    }

    pub fn inbox_full(&self, to: &str) -> bool {
        self.with(|state| state.inbox_full(to))
    }

    pub fn enqueue(&self, draft: MailDraft) -> Mail {
        self.with(|state| state.enqueue(draft))
    }

    pub fn claim_wake(&self, external_id: &str, now: i64, max: usize, window_ms: i64) -> bool {
        self.with(|state| {
            let wakes = &mut state.data.wakes.0;
            wakes.retain_mut(|(_, times)| {
                times.retain(|at| *at > now - window_ms);
                !times.is_empty()
            });
            let known = wakes.iter().position(|(id, _)| id == external_id);
            let recent = known.map_or(0, |index| wakes[index].1.len());
            if recent >= max {
                return false;
            }
            match known {
                Some(index) => wakes[index].1.push(now),
                None => wakes.push((external_id.to_owned(), vec![now])),
            }
            state.mark_dirty();
            true
        })
    }

    pub fn post_event(&self, from: &str, to: &str, text: &str) {
        self.with(|state| {
            let now = state.now();
            let open = state.data.mail.iter_mut().find(|mail| {
                mail.kind == MailKind::Event
                    && mail.state == MailState::Queued
                    && mail.from == from
                    && mail.to == to
            });
            let Some(open) = open else {
                state.enqueue(MailDraft {
                    kind: Some(MailKind::Event),
                    ..MailDraft::new(from, to, text)
                });
                return;
            };
            let mut lines: Vec<&str> = open.text.as_deref().unwrap_or("").split('\n').collect();
            lines.push(text);
            let from_end = lines.len().saturating_sub(EVENT_LINES_MAX);
            open.text = Some(lines[from_end..].join("\n"));
            open.preview = bus_preview(text);
            open.ts = format_iso(now);
            state.mark_dirty();
        });
    }

    pub fn watch_pane(&self, subscriber: &str, watched: &str, until: &[&str]) {
        self.with(|state| {
            let until: Vec<String> = until.iter().map(|item| (*item).to_owned()).collect();
            let known = state
                .data
                .watches
                .iter_mut()
                .find(|watch| watch.subscriber == subscriber && watch.watched == watched);
            match known {
                Some(watch) => watch.until = until,
                None => state.data.watches.push(Watch {
                    subscriber: subscriber.to_owned(),
                    watched: watched.to_owned(),
                    until,
                }),
            }
            state.mark_dirty();
        });
    }

    pub fn unwatch_panes(&self, subscriber: &str, watched: Option<&[&str]>) {
        self.with(|state| {
            let before = state.data.watches.len();
            state.data.watches.retain(|watch| {
                watch.subscriber != subscriber
                    || watched.is_some_and(|list| !list.contains(&watch.watched.as_str()))
            });
            if state.data.watches.len() != before {
                state.mark_dirty();
            }
        });
    }

    pub fn watches_of(&self, subscriber: &str) -> Vec<Watch> {
        self.with(|state| {
            state
                .data
                .watches
                .iter()
                .filter(|watch| watch.subscriber == subscriber)
                .cloned()
                .collect()
        })
    }

    pub fn watchers_of(&self, watched: &str) -> Vec<Watch> {
        self.with(|state| {
            state
                .data
                .watches
                .iter()
                .filter(|watch| watch.watched == watched)
                .cloned()
                .collect()
        })
    }

    pub fn drop_watches_of(&self, external_id: &str) {
        self.with(|state| {
            let before = state.data.watches.len();
            state
                .data
                .watches
                .retain(|watch| watch.subscriber != external_id && watch.watched != external_id);
            if state.data.watches.len() != before {
                state.mark_dirty();
            }
        });
    }

    pub fn set_pending(&self, id: &str, pending: MailPending) {
        self.with(|state| {
            let Some(mail) = state.data.mail.iter_mut().find(|item| item.id == id) else {
                return;
            };
            if mail.state != MailState::Queued || mail.pending == Some(pending) {
                return;
            }
            mail.pending = Some(pending);
            state.mark_dirty();
        });
    }

    pub fn get_mail(&self, id: &str) -> Option<Mail> {
        self.with(|state| {
            state.sweep();
            state.data.mail.iter().find(|item| item.id == id).cloned()
        })
    }

    pub fn queued_counts(&self) -> HashMap<String, usize> {
        self.with(|state| {
            state.sweep();
            let mut counts: HashMap<String, usize> = HashMap::new();
            for mail in &state.data.mail {
                if mail.state == MailState::Queued && !mail.quiet {
                    *counts.entry(mail.to.clone()).or_insert(0) += 1;
                }
            }
            counts
        })
    }

    pub fn inbox_of(&self, to: &str) -> Vec<Mail> {
        self.with(|state| {
            state.sweep();
            state
                .data
                .mail
                .iter()
                .filter(|mail| mail.to == to && undelivered(mail))
                .cloned()
                .collect()
        })
    }

    pub fn sent_by(&self, from: &str) -> Vec<Mail> {
        self.with(|state| {
            state.sweep();
            let sent: Vec<&Mail> = state
                .data
                .mail
                .iter()
                .filter(|mail| mail.from == from && !mail.quiet && mail.kind != MailKind::Event)
                .collect();
            sent[sent.len().saturating_sub(SENT_LISTED)..]
                .iter()
                .map(|mail| (*mail).clone())
                .collect()
        })
    }

    pub fn mail_counts(&self, pane: &str) -> MailCounts {
        self.with(|state| {
            state.sweep();
            let now = state.now();
            let mut counts = MailCounts {
                queued: 0,
                failed: 0,
                sent_queued: 0,
                sent_failed: 0,
                oldest_queued_ms: None,
                last_failure: None,
            };
            for mail in &state.data.mail {
                if mail.quiet {
                    continue;
                }
                if mail.to == pane {
                    if undelivered(mail) {
                        counts.queued += 1;
                        let waited = age_since(&mail.ts, now);
                        counts.oldest_queued_ms =
                            Some(counts.oldest_queued_ms.unwrap_or(0).max(waited));
                    } else if mail.state == MailState::Failed {
                        counts.failed += 1;
                        counts.last_failure.clone_from(&mail.reason);
                    }
                }
                if mail.from == pane && mail.kind != MailKind::Event {
                    if undelivered(mail) {
                        counts.sent_queued += 1;
                    } else if mail.state == MailState::Failed {
                        counts.sent_failed += 1;
                    }
                }
            }
            counts
        })
    }

    pub fn mail_views(&self) -> Vec<MailView> {
        self.with(|state| {
            state.sweep();
            let mut failed_per_pane: HashMap<&str, usize> = HashMap::new();
            let mut views = Vec::new();
            for item in state.data.mail.iter().rev() {
                if item.quiet {
                    continue;
                }
                let view = |kind: MailViewState| MailView {
                    id: item.id.clone(),
                    state: kind,
                    from: item.from.clone(),
                    to: item.to.clone(),
                    ts: item.ts.clone(),
                    pending: None,
                    reason: None,
                };
                if undelivered(item) {
                    views.push(MailView {
                        pending: item.pending,
                        ..view(MailViewState::Queued)
                    });
                } else if item.state == MailState::Failed && !item.dismissed {
                    let shown = failed_per_pane.entry(item.to.as_str()).or_insert(0);
                    if *shown >= FAILED_SHOWN_MAX {
                        continue;
                    }
                    *shown += 1;
                    views.push(MailView {
                        reason: item.reason.clone().filter(|reason| !reason.is_empty()),
                        ..view(MailViewState::Failed)
                    });
                }
            }
            views.reverse();
            views
        })
    }

    pub fn dismiss_failed(&self, to: &str) {
        self.with(|state| {
            let mut changed = false;
            for item in &mut state.data.mail {
                if item.to == to && item.state == MailState::Failed && !item.dismissed {
                    item.dismissed = true;
                    changed = true;
                }
            }
            if changed {
                state.mark_dirty();
            }
        });
    }

    pub fn lease_mail(
        &self,
        to: &str,
        via: MailVia,
        pick: impl Fn(&Mail) -> bool,
    ) -> Option<HandedMail> {
        self.with(|state| state.lease(to, via, &pick))
    }

    pub fn ack_mail(&self, to: &str, lease: &str) -> Vec<String> {
        self.with(|state| {
            state.sweep();
            let at = state.now();
            let mut acked = Vec::new();
            for mail in &mut state.data.mail {
                if mail.to != to
                    || mail.state != MailState::Leased
                    || mail.lease.as_deref() != Some(lease)
                {
                    continue;
                }
                let via = mail.via.unwrap_or(MailVia::Prompt);
                deliver_mail(&mut state.effects, mail, via, at);
                acked.push(mail.id.clone());
            }
            if !acked.is_empty() {
                state.mark_dirty();
            }
            acked
        })
    }

    pub fn release_mail(&self, to: &str, lease: &str) {
        self.with(|state| state.release(to, lease));
    }

    pub fn fail_leased(&self, to: &str, lease: &str, reason: &str) {
        self.with(|state| {
            state.fail_where(reason, |mail| {
                mail.to == to
                    && mail.state == MailState::Leased
                    && mail.lease.as_deref() == Some(lease)
            });
        });
    }

    pub fn fail_pane_mail(&self, to: &str) {
        self.with(|state| {
            state.fail_where(MAIL_PANE_CLOSED, |mail| mail.to == to && undelivered(mail));
        });
    }

    pub fn sent_after(&self, id: &str, ts: &str) -> impl Fn(&Mail) -> bool + Send + Sync + use<> {
        let earlier: Option<HashSet<String>> = self.with(|state| {
            let list = &state.data.mail;
            list.iter()
                .position(|mail| mail.id == id)
                .map(|at| list[..=at].iter().map(|mail| mail.id.clone()).collect())
        });
        let ts = ts.to_owned();
        move |mail| match &earlier {
            None => mail.ts >= ts,
            Some(earlier) => !earlier.contains(&mail.id),
        }
    }

    pub fn add_waiter(&self, to: &str, pick: Option<MailPick>) -> Waiter {
        let (sender, receiver) = oneshot::channel();
        let mut state = self.inner.state.lock();
        state.next_waiter += 1;
        let id = state.next_waiter;
        state
            .waiters
            .entry(to.to_owned())
            .or_default()
            .push(WaiterEntry { id, pick, sender });
        Waiter {
            inner: Arc::clone(&self.inner),
            to: to.to_owned(),
            id,
            receiver,
        }
    }

    pub fn post_bus_message(&self, from: &str, to: &str, text: &str) -> String {
        self.enqueue(MailDraft {
            quiet: true,
            ..MailDraft::new(from, to, text)
        })
        .id
    }

    pub fn tell_pane(&self, to: &str, text: &str) -> String {
        self.enqueue(MailDraft::new(OSTIA_SENDER, to, text)).id
    }
}
