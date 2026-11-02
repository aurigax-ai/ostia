use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, LazyLock};

use futures_util::future::BoxFuture;
use ostia_base::clock::Clock;
use ostia_base::js::static_regex;
use ostia_contract::incident::{
    CallPhase, INCIDENT_EVENTS_MAX, INCIDENT_KEEP_MS, INCIDENT_KEPT_MAX, INCIDENT_PANES_MAX,
    INCIDENT_STALL_MS, INCIDENT_WINDOW_MS,
};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value};

const MERGE_MS: i64 = 60_000;
const TOTALS_KEYS_MAX: usize = 120;
const STALL_MS: i64 = INCIDENT_STALL_MS as i64;
const WINDOW_MS: i64 = INCIDENT_WINDOW_MS as i64;
const KEEP_MS: i64 = INCIDENT_KEEP_MS as i64;

static METHOD: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][A-Za-z.]{0,60}$"));
static CODE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][a-z.-]{0,40}$"));

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneSnapshot {
    pub agent: String,
    pub state: String,
    pub drafting: bool,
    pub mail: u64,
    pub alive: bool,
}

#[derive(Debug, Clone)]
pub enum RawEvent {
    Call {
        at: i64,
        method: String,
        phase: CallPhase,
        from: Option<String>,
        name: Option<String>,
        ms: Option<i64>,
        code: Option<String>,
        before: Option<PaneSnapshot>,
        after: Option<PaneSnapshot>,
    },
    State {
        at: i64,
        to: String,
        from: Option<String>,
    },
    Hook {
        at: i64,
        ok: bool,
        code: Option<String>,
    },
    Mail {
        at: i64,
        code: String,
        age: Option<i64>,
    },
    Wake {
        at: i64,
        code: String,
        ms: i64,
    },
}

impl RawEvent {
    pub fn at(&self) -> i64 {
        match self {
            Self::Call { at, .. }
            | Self::State { at, .. }
            | Self::Hook { at, .. }
            | Self::Mail { at, .. }
            | Self::Wake { at, .. } => *at,
        }
    }
}

pub type SnapshotFn = Arc<dyn Fn(&str) -> BoxFuture<'static, Option<PaneSnapshot>> + Send + Sync>;

pub struct IncidentTimelineDeps {
    pub now: Clock,
    pub snapshot: SnapshotFn,
}

#[derive(Debug, Clone)]
pub struct IncidentTake {
    pub pane_id: String,
    pub agent: String,
    pub events: Vec<RawEvent>,
    pub trigger: String,
    pub callers: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct IncidentListed {
    pub reference: String,
    pub trigger: String,
    pub agent: String,
    pub age_ms: i64,
}

#[derive(Debug, Clone)]
pub struct IncidentTotals {
    pub since_min: u64,
    pub counts: Map<String, Value>,
}

struct Stamped {
    id: u64,
    event: RawEvent,
}

type Ring = VecDeque<Stamped>;

struct CallState {
    id: u64,
    name: String,
    caller: Option<String>,
    began: i64,
    pane_id: Mutex<String>,
}

struct Kept {
    id: u64,
    pane_id: String,
    agent: String,
    trigger: String,
    at: i64,
    source_at: i64,
    events: Vec<RawEvent>,
}

enum Target {
    Before(u64),
    After(u64),
    KeptAgent(u64),
}

struct Pending {
    pane_id: String,
    target: Target,
}

struct Found {
    code: String,
    at: i64,
}

#[derive(Default)]
struct State {
    rings: Vec<(String, Ring)>,
    open: Vec<Arc<CallState>>,
    kept: Vec<Kept>,
    totals: Vec<(String, u64)>,
    kept_seq: u64,
    event_seq: u64,
    call_seq: u64,
}

struct Inner {
    deps: IncidentTimelineDeps,
    started_at: i64,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct IncidentTimeline {
    inner: Arc<Inner>,
}

#[derive(Clone)]
pub struct IncidentCall {
    inner: Arc<Inner>,
    call: Arc<CallState>,
}

tokio::task_local! {
    static CALLS: IncidentCall;
}

pub async fn run_in_incident<F: Future>(call: Option<IncidentCall>, run: F) -> F::Output {
    match call {
        Some(call) => CALLS.scope(call, run).await,
        None => run.await,
    }
}

pub fn bind_incident(pane_id: &str) {
    let _ = CALLS.try_with(|call| call.bind(pane_id));
}

fn code(value: &str, fallback: &str) -> String {
    if CODE.is_match(value) {
        value.to_owned()
    } else {
        fallback.to_owned()
    }
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

fn specific_of(ring: &Ring) -> Option<Found> {
    for stamped in ring.iter().rev() {
        match &stamped.event {
            RawEvent::Mail { code, at, .. } | RawEvent::Wake { code, at, .. } => {
                return Some(Found {
                    code: code.clone(),
                    at: *at,
                });
            }
            RawEvent::Hook {
                ok: false,
                code,
                at,
            } => {
                return Some(Found {
                    code: code.clone().unwrap_or_else(|| "hook-failed".to_owned()),
                    at: *at,
                });
            }
            RawEvent::Call {
                phase: CallPhase::End,
                code: Some(code),
                at,
                ..
            } if !code.is_empty() => {
                return Some(Found {
                    code: code.clone(),
                    at: *at,
                });
            }
            _ => {}
        }
    }
    None
}

fn slow_of(ring: &Ring) -> Option<Found> {
    for stamped in ring.iter().rev() {
        let RawEvent::Call { phase, ms, at, .. } = &stamped.event else {
            continue;
        };
        if matches!(phase, CallPhase::End) && ms.unwrap_or(0) >= STALL_MS {
            return Some(Found {
                code: "slow-call".to_owned(),
                at: *at,
            });
        }
        if matches!(phase, CallPhase::Cancel) {
            return Some(Found {
                code: "call-cancelled".to_owned(),
                at: *at,
            });
        }
    }
    None
}

fn callers_of(events: &[RawEvent]) -> Vec<String> {
    let mut callers: Vec<String> = Vec::new();
    for event in events {
        if let RawEvent::Call {
            from: Some(from), ..
        } = event
            && !from.is_empty()
            && !callers.contains(from)
        {
            callers.push(from.clone());
        }
    }
    callers
}

fn prune(ring: &mut Ring, now: i64) {
    while ring
        .front()
        .is_some_and(|stamped| now - stamped.event.at() > WINDOW_MS)
    {
        ring.pop_front();
    }
    while ring.len() > INCIDENT_EVENTS_MAX {
        ring.pop_front();
    }
}

impl State {
    fn ring(&self, pane_id: &str) -> Option<&Ring> {
        self.rings
            .iter()
            .find(|(name, _)| name == pane_id)
            .map(|(_, ring)| ring)
    }

    fn ring_mut(&mut self, pane_id: &str) -> Option<&mut Ring> {
        self.rings
            .iter_mut()
            .find(|(name, _)| name == pane_id)
            .map(|(_, ring)| ring)
    }

    fn stalled_open(&self, pane_id: &str, now: i64) -> bool {
        self.open
            .iter()
            .any(|call| *call.pane_id.lock() == pane_id && now - call.began >= STALL_MS)
    }

    fn trigger_of(&self, pane_id: &str, ring: &Ring, now: i64) -> Option<String> {
        specific_of(ring).map(|found| found.code).or_else(|| {
            if self.stalled_open(pane_id, now) {
                Some("call-open".to_owned())
            } else {
                slow_of(ring).map(|found| found.code)
            }
        })
    }

    fn freeze(&mut self, pane_id: &str, now: i64, pending: &mut Vec<Pending>) {
        let Some(ring) = self.ring(pane_id) else {
            return;
        };
        let Some(found) = specific_of(ring).or_else(|| slow_of(ring)) else {
            return;
        };
        let events: Vec<RawEvent> = ring.iter().map(|stamped| stamped.event.clone()).collect();
        if let Some(last) = self.kept.last_mut()
            && last.pane_id == pane_id
            && now - last.at < MERGE_MS
        {
            last.trigger = found.code;
            last.at = now;
            last.source_at = last.source_at.max(found.at);
            last.events = events;
            return;
        }
        if self
            .kept
            .iter()
            .any(|entry| entry.pane_id == pane_id && entry.source_at >= found.at)
        {
            return;
        }
        while self
            .kept
            .first()
            .is_some_and(|entry| now - entry.at > KEEP_MS)
        {
            self.kept.remove(0);
        }
        while self.kept.len() >= INCIDENT_KEPT_MAX {
            self.kept.remove(0);
        }
        self.kept_seq += 1;
        let id = self.kept_seq;
        self.kept.push(Kept {
            id,
            pane_id: pane_id.to_owned(),
            agent: "other".to_owned(),
            trigger: found.code,
            at: now,
            source_at: found.at,
            events,
        });
        pending.push(Pending {
            pane_id: pane_id.to_owned(),
            target: Target::KeptAgent(id),
        });
    }

    fn push(&mut self, pane_id: &str, event: RawEvent, pending: &mut Vec<Pending>) -> u64 {
        if self.ring(pane_id).is_none() {
            if self.rings.len() >= INCIDENT_PANES_MAX {
                self.rings.remove(0);
            }
            self.rings.push((pane_id.to_owned(), Ring::new()));
        }
        self.event_seq += 1;
        let id = self.event_seq;
        let at = event.at();
        let is_state = matches!(event, RawEvent::State { .. });
        if let Some(ring) = self.ring_mut(pane_id) {
            ring.push_back(Stamped { id, event });
            prune(ring, at);
        }
        if !is_state {
            self.freeze(pane_id, at, pending);
        }
        id
    }

    fn count(&mut self, method: &str, result: Option<&str>) {
        let key = format!("{method}.{}", result.unwrap_or("ok"));
        if let Some((_, total)) = self.totals.iter_mut().find(|(name, _)| *name == key) {
            *total += 1;
            return;
        }
        if self.totals.len() >= TOTALS_KEYS_MAX {
            return;
        }
        self.totals.push((key, 1));
    }

    fn apply(&mut self, pane_id: &str, target: &Target, snapshot: PaneSnapshot) {
        match target {
            Target::KeptAgent(id) => {
                if let Some(entry) = self.kept.iter_mut().find(|entry| entry.id == *id) {
                    entry.agent = snapshot.agent;
                }
            }
            Target::Before(id) | Target::After(id) => {
                let Some(ring) = self.ring_mut(pane_id) else {
                    return;
                };
                let Some(stamped) = ring.iter_mut().find(|stamped| stamped.id == *id) else {
                    return;
                };
                if let RawEvent::Call { before, after, .. } = &mut stamped.event {
                    match target {
                        Target::Before(_) => *before = Some(snapshot),
                        _ => *after = Some(snapshot),
                    }
                }
            }
        }
    }
}

impl Inner {
    fn dispatch(self: &Arc<Self>, pending: Vec<Pending>) {
        for item in pending {
            let future = (self.deps.snapshot)(&item.pane_id);
            let Ok(runtime) = tokio::runtime::Handle::try_current() else {
                continue;
            };
            let inner = self.clone();
            runtime.spawn(async move {
                if let Some(snapshot) = future.await {
                    inner
                        .state
                        .lock()
                        .apply(&item.pane_id, &item.target, snapshot);
                }
            });
        }
    }

    fn now(&self) -> i64 {
        (self.deps.now)()
    }

    fn attach(self: &Arc<Self>, call: &Arc<CallState>, pane_id: &str) {
        let mut pending = Vec::new();
        {
            let mut state = self.state.lock();
            *call.pane_id.lock() = pane_id.to_owned();
            if !state.open.iter().any(|open| open.id == call.id) {
                state.open.push(call.clone());
            }
            let start = RawEvent::Call {
                at: call.began,
                method: call.name.clone(),
                phase: CallPhase::Start,
                from: call.caller.clone().filter(|caller| !caller.is_empty()),
                name: None,
                ms: None,
                code: None,
                before: None,
                after: None,
            };
            let id = state.push(pane_id, start, &mut pending);
            pending.push(Pending {
                pane_id: pane_id.to_owned(),
                target: Target::Before(id),
            });
        }
        self.dispatch(pending);
    }
}

impl IncidentCall {
    pub fn bind(&self, pane_id: &str) {
        if self.call.pane_id.lock().is_empty() {
            self.inner.attach(&self.call, pane_id);
        }
    }

    pub fn phase(&self, name: &str) {
        let at = self.inner.now();
        let ms = self.inner.now() - self.call.began;
        let mut pending = Vec::new();
        {
            let mut state = self.inner.state.lock();
            if !state.open.iter().any(|open| open.id == self.call.id) {
                return;
            }
            let pane_id = self.call.pane_id.lock().clone();
            state.push(
                &pane_id,
                RawEvent::Call {
                    at,
                    method: self.call.name.clone(),
                    phase: CallPhase::Phase,
                    from: None,
                    name: Some(code(name, "other")),
                    ms: Some(ms),
                    code: None,
                    before: None,
                    after: None,
                },
                &mut pending,
            );
        }
        self.inner.dispatch(pending);
    }

    pub fn end(&self, result: Option<&str>) {
        self.finish(CallPhase::End, result);
    }

    pub fn cancel(&self) {
        self.finish(CallPhase::Cancel, None);
    }

    fn finish(&self, phase: CallPhase, result: Option<&str>) {
        let at = self.inner.now();
        let result = result.filter(|result| !result.is_empty());
        let mut pending = Vec::new();
        {
            let mut state = self.inner.state.lock();
            let position = state.open.iter().position(|open| open.id == self.call.id);
            let bound = position.is_some();
            if let Some(position) = position {
                state.open.remove(position);
            }
            let counted = if matches!(phase, CallPhase::Cancel) {
                Some("cancelled".to_owned())
            } else {
                result.map(|result| code(result, "error"))
            };
            state.count(&self.call.name, counted.as_deref());
            if !bound {
                return;
            }
            let pane_id = self.call.pane_id.lock().clone();
            let done = RawEvent::Call {
                at,
                method: self.call.name.clone(),
                phase,
                from: self.call.caller.clone().filter(|caller| !caller.is_empty()),
                name: None,
                ms: Some(at - self.call.began),
                code: result.map(|result| code(result, "error")),
                before: None,
                after: None,
            };
            let id = state.push(&pane_id, done, &mut pending);
            pending.push(Pending {
                pane_id,
                target: Target::After(id),
            });
        }
        self.inner.dispatch(pending);
    }
}

impl IncidentTimeline {
    pub fn new(deps: IncidentTimelineDeps) -> Self {
        let started_at = (deps.now)();
        Self {
            inner: Arc::new(Inner {
                deps,
                started_at,
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn begin(&self, target: Option<&str>, method: &str, caller: Option<&str>) -> IncidentCall {
        let began = self.inner.now();
        let name = if METHOD.is_match(method) {
            method.to_owned()
        } else {
            "other".to_owned()
        };
        let id = {
            let mut state = self.inner.state.lock();
            state.call_seq += 1;
            state.call_seq
        };
        let target = target.unwrap_or("");
        let call = Arc::new(CallState {
            id,
            name,
            caller: caller.map(str::to_owned),
            began,
            pane_id: Mutex::new(target.to_owned()),
        });
        if !target.is_empty() {
            self.inner.attach(&call, target);
        }
        IncidentCall {
            inner: self.inner.clone(),
            call,
        }
    }

    fn record(&self, pane_id: &str, event: RawEvent) {
        let mut pending = Vec::new();
        self.inner.state.lock().push(pane_id, event, &mut pending);
        self.inner.dispatch(pending);
    }

    pub fn state(&self, pane_id: &str, to: &str, from: Option<&str>) {
        self.record(
            pane_id,
            RawEvent::State {
                at: self.inner.now(),
                to: code(to, "other"),
                from: from
                    .filter(|from| !from.is_empty())
                    .map(|from| code(from, "other")),
            },
        );
    }

    pub fn hook(&self, pane_id: &str, ok: bool, result: Option<&str>) {
        self.record(
            pane_id,
            RawEvent::Hook {
                at: self.inner.now(),
                ok,
                code: result
                    .filter(|result| !result.is_empty())
                    .map(|result| code(result, "other")),
            },
        );
    }

    pub fn mail(&self, pane_id: &str, result: &str, age: f64) {
        self.record(
            pane_id,
            RawEvent::Mail {
                at: self.inner.now(),
                code: code(result, "other"),
                age: Some(js_round(age)),
            },
        );
    }

    pub fn wake(&self, pane_id: &str, result: &str, ms: f64) {
        self.record(
            pane_id,
            RawEvent::Wake {
                at: self.inner.now(),
                code: code(result, "other"),
                ms: js_round(ms),
            },
        );
    }

    pub fn forget(&self, pane_id: &str) {
        let mut state = self.inner.state.lock();
        state.rings.retain(|(name, _)| name != pane_id);
        state.open.retain(|call| *call.pane_id.lock() != pane_id);
    }

    pub fn list(&self, period_ms: u64) -> Vec<IncidentListed> {
        let now = self.inner.now();
        let period = i64::try_from(period_ms).unwrap_or(i64::MAX);
        let mut state = self.inner.state.lock();
        let mut out: Vec<IncidentListed> = state
            .kept
            .iter()
            .filter(|entry| now - entry.at <= period)
            .map(|entry| IncidentListed {
                reference: format!("i{}", entry.id),
                trigger: entry.trigger.clone(),
                agent: entry.agent.clone(),
                age_ms: now - entry.at,
            })
            .collect();
        let panes: Vec<String> = state.rings.iter().map(|(name, _)| name.clone()).collect();
        for pane_id in panes {
            if let Some(ring) = state.ring_mut(&pane_id) {
                prune(ring, now);
            }
            let has_specific = state
                .ring(&pane_id)
                .is_some_and(|ring| specific_of(ring).is_some());
            if state.stalled_open(&pane_id, now) && !has_specific {
                out.push(IncidentListed {
                    reference: pane_id,
                    trigger: "call-open".to_owned(),
                    agent: "other".to_owned(),
                    age_ms: 0,
                });
            }
        }
        out.sort_by_key(|item| item.age_ms);
        out
    }

    pub fn take(&self, reference: &str) -> Option<IncidentTake> {
        let now = self.inner.now();
        let mut state = self.inner.state.lock();
        if let Some(frozen) = state
            .kept
            .iter()
            .find(|entry| format!("i{}", entry.id) == reference)
        {
            return Some(IncidentTake {
                pane_id: frozen.pane_id.clone(),
                agent: frozen.agent.clone(),
                events: frozen.events.clone(),
                trigger: frozen.trigger.clone(),
                callers: callers_of(&frozen.events),
            });
        }
        let ring = state.ring_mut(reference)?;
        prune(ring, now);
        let mut events: Vec<RawEvent> = ring.iter().map(|stamped| stamped.event.clone()).collect();
        let state = &*state;
        for call in &state.open {
            if *call.pane_id.lock() == reference && now - call.began >= STALL_MS {
                events.push(RawEvent::Call {
                    at: now,
                    method: call.name.clone(),
                    phase: CallPhase::Phase,
                    from: call.caller.clone().filter(|caller| !caller.is_empty()),
                    name: Some("never-returned".to_owned()),
                    ms: Some(now - call.began),
                    code: None,
                    before: None,
                    after: None,
                });
            }
        }
        let ring = state.ring(reference)?;
        let trigger = state
            .trigger_of(reference, ring, now)
            .unwrap_or_else(|| "manual".to_owned());
        Some(IncidentTake {
            pane_id: reference.to_owned(),
            agent: "other".to_owned(),
            callers: callers_of(&events),
            events,
            trigger,
        })
    }

    pub fn totals(&self) -> IncidentTotals {
        let elapsed = self.inner.now() - self.inner.started_at;
        let state = self.inner.state.lock();
        IncidentTotals {
            since_min: u64::try_from(elapsed.div_euclid(60_000)).unwrap_or(0),
            counts: state
                .totals
                .iter()
                .map(|(key, total)| (key.clone(), Value::from(*total)))
                .collect(),
        }
    }

    pub fn clear(&self) {
        let mut state = self.inner.state.lock();
        state.rings.clear();
        state.open.clear();
        state.kept.clear();
        state.totals.clear();
    }
}
