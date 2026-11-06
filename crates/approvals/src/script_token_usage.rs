use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared, join};
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::clock::{Clock, system_clock};
use ostia_base::json_store::load_json;
use ostia_contract::script_tokens::{
    ScriptTokenCall, ScriptTokenCallOutcome, ScriptTokenCallTarget,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::script_token_requests::ReachListing;

pub const USAGE_KEEP: usize = 100;
const HOUR_MS: i64 = 3_600_000;
const HOURS: usize = 24;
const FLUSH_MS: u64 = 5_000;

type HourBucket = (i64, i64, i64);
type KnownTokens = Arc<dyn Fn() -> HashSet<String> + Send + Sync>;
type Writing = Shared<BoxFuture<'static, ()>>;
type ListingFuture = BoxFuture<'static, Result<ReachListing, String>>;
type PanesFuture = BoxFuture<'static, Result<Vec<PaneTitle>, String>>;
type ListingLookup = Arc<dyn Fn() -> ListingFuture + Send + Sync>;
type PanesLookup = Arc<dyn Fn() -> PanesFuture + Send + Sync>;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ConnectionSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Last24h {
    pub calls: u64,
    pub refused: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UsageSnapshot {
    pub calls: Vec<ScriptTokenCall>,
    pub connections: Vec<ConnectionSource>,
    pub last24h: Last24h,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct UsageNames {
    pub workspaces: BTreeMap<String, String>,
    pub panes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ScriptTokenUsage {
    pub calls: Vec<ScriptTokenCall>,
    pub connections: Vec<ConnectionSource>,
    pub last24h: Last24h,
    pub names: UsageNames,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageCall {
    pub method: String,
    pub target: ScriptTokenCallTarget,
    pub outcome: ScriptTokenCallOutcome,
    pub code: Option<String>,
}

#[derive(Clone)]
pub struct UsageLogOptions {
    pub now: Clock,
    pub flush_ms: u64,
    pub known: Option<KnownTokens>,
}

impl Default for UsageLogOptions {
    fn default() -> Self {
        Self {
            now: system_clock(),
            flush_ms: FLUSH_MS,
            known: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneTitle {
    pub pane_id: String,
    pub title: String,
}

#[derive(Clone)]
pub struct UsageLookups {
    listing: ListingLookup,
    panes: Option<PanesLookup>,
}

impl UsageLookups {
    pub fn new<F>(listing: F) -> Self
    where
        F: Fn() -> ListingFuture + Send + Sync + 'static,
    {
        Self {
            listing: Arc::new(listing),
            panes: None,
        }
    }

    pub fn with_panes<F>(mut self, panes: F) -> Self
    where
        F: Fn() -> PanesFuture + Send + Sync + 'static,
    {
        self.panes = Some(Arc::new(panes));
        self
    }
}

fn refused(outcome: ScriptTokenCallOutcome) -> bool {
    matches!(
        outcome,
        ScriptTokenCallOutcome::OutOfScope | ScriptTokenCallOutcome::MissingPermission
    )
}

fn parse_outcome(text: &str) -> Option<ScriptTokenCallOutcome> {
    match text {
        "ok" => Some(ScriptTokenCallOutcome::Ok),
        "out-of-scope" => Some(ScriptTokenCallOutcome::OutOfScope),
        "missing-permission" => Some(ScriptTokenCallOutcome::MissingPermission),
        "error" => Some(ScriptTokenCallOutcome::Error),
        "regenerated" => Some(ScriptTokenCallOutcome::Regenerated),
        _ => None,
    }
}

fn is_date(text: &str) -> bool {
    DateTime::parse_from_rfc3339(text).is_ok()
        || NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
        || NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M").is_ok()
        || NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
}

fn iso_time(at: i64) -> String {
    DateTime::from_timestamp_millis(at)
        .unwrap_or(DateTime::UNIX_EPOCH)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn integer(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    if let Some(exact) = number.as_i64() {
        return Some(exact);
    }
    let float = number.as_f64()?;
    (float.fract() == 0.0 && float.abs() < 9_007_199_254_740_992.0).then_some(float as i64)
}

#[derive(Default)]
struct Ring {
    calls: VecDeque<ScriptTokenCall>,
    hours: [Option<HourBucket>; HOURS],
}

impl Ring {
    fn push(&mut self, call: ScriptTokenCall) {
        if self.calls.len() == USAGE_KEEP {
            self.calls.pop_front();
        }
        self.calls.push_back(call);
    }

    fn count(&mut self, at: i64, outcome: ScriptTokenCallOutcome) {
        if outcome == ScriptTokenCallOutcome::Regenerated {
            return;
        }
        let hour = at.div_euclid(HOUR_MS);
        let slot = hour.rem_euclid(HOURS as i64) as usize;
        let bucket = match self.hours[slot] {
            Some(live) if live.0 == hour => live,
            _ => (hour, 0, 0),
        };
        self.hours[slot] = Some((
            bucket.0,
            bucket.1 + 1,
            bucket.2 + i64::from(refused(outcome)),
        ));
    }

    fn stored(&self) -> Value {
        let hours: Vec<Value> = self
            .hours
            .iter()
            .flatten()
            .map(|(hour, calls, refused)| json!([hour, calls, refused]))
            .collect();
        let calls: Vec<Value> = self
            .calls
            .iter()
            .filter_map(|call| serde_json::to_value(call).ok())
            .collect();
        json!({"calls": calls, "hours": hours})
    }
}

fn stored_call(raw: &Value) -> Option<ScriptTokenCall> {
    let at = raw.get("at")?.as_str()?;
    if !is_date(at) {
        return None;
    }
    let method = raw.get("method")?.as_str()?;
    let outcome = parse_outcome(raw.get("outcome")?.as_str()?)?;
    let target = raw.get("target");
    let text = |key: &str| {
        target
            .and_then(|t| t.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Some(ScriptTokenCall {
        at: at.to_owned(),
        method: method.to_owned(),
        target: ScriptTokenCallTarget {
            workspace_id: text("workspaceId"),
            pane_id: text("paneId"),
        },
        outcome,
        code: raw.get("code").and_then(Value::as_str).map(str::to_owned),
    })
}

fn stored_hour(raw: &Value) -> Option<HourBucket> {
    let [hour, calls, refused] = raw.as_array()?.as_slice() else {
        return None;
    };
    Some((integer(hour)?, integer(calls)?, integer(refused)?))
}

fn load_rings(path: &std::path::Path) -> Vec<(String, Ring)> {
    let Some(Value::Object(raw)) = load_json(path) else {
        return Vec::new();
    };
    raw.iter()
        .map(|(id, stored)| {
            let mut ring = Ring::default();
            let calls = stored
                .get("calls")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            for call in &calls[calls.len().saturating_sub(USAGE_KEEP)..] {
                if let Some(clean) = stored_call(call) {
                    ring.push(clean);
                }
            }
            let hours = stored
                .get("hours")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            for bucket in hours.iter().filter_map(stored_hour) {
                if bucket.0 >= 0 {
                    ring.hours[(bucket.0 % HOURS as i64) as usize] = Some(bucket);
                }
            }
            (id.clone(), ring)
        })
        .collect()
}

fn write_compact(path: &std::path::Path, out: &Value) -> ostia_base::Result<()> {
    write_file_atomic(path, out.to_string().as_bytes(), AtomicWriteOptions::SECURE)
}

struct State {
    rings: Option<Vec<(String, Ring)>>,
    connections: HashMap<String, BTreeMap<u64, ConnectionSource>>,
    gone: HashSet<String>,
    timer: Option<JoinHandle<()>>,
    writing: Writing,
    next_key: u64,
    writes: u64,
}

struct Inner {
    path: PathBuf,
    options: UsageLogOptions,
    state: Mutex<State>,
    landed: Arc<Mutex<u64>>,
}

impl Inner {
    fn loaded<'a>(&self, state: &'a mut State) -> &'a mut Vec<(String, Ring)> {
        state.rings.get_or_insert_with(|| load_rings(&self.path))
    }

    fn snapshot(&self, state: &State) -> Option<Value> {
        let rings = state.rings.as_ref()?;
        let known = self.options.known.as_ref().map(|known| known());
        let mut out = Map::new();
        for (id, ring) in rings {
            if state.gone.contains(id) || known.as_ref().is_some_and(|known| !known.contains(id)) {
                continue;
            }
            out.insert(id.clone(), ring.stored());
        }
        Some(Value::Object(out))
    }

    fn cancel(state: &mut State) {
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
    }

    fn flush(&self) -> Writing {
        let mut state = self.state.lock();
        Self::cancel(&mut state);
        let Some(out) = self.snapshot(&state) else {
            return state.writing.clone();
        };
        let target = self.path.clone();
        let previous = state.writing.clone();
        state.writes += 1;
        let sequence = state.writes;
        let landed = Arc::clone(&self.landed);
        let next: Writing = async move {
            previous.await;
            let written = tokio::task::spawn_blocking(move || {
                let mut newest = landed.lock();
                if *newest > sequence {
                    return Ok(());
                }
                let result = write_compact(&target, &out);
                if result.is_ok() {
                    *newest = sequence;
                }
                result
            })
            .await;
            match written {
                Ok(Ok(())) => {}
                Ok(Err(err)) => tracing::error!("[script-token-usage] write failed: {err}"),
                Err(err) => tracing::error!("[script-token-usage] write failed: {err}"),
            }
        }
        .boxed()
        .shared();
        state.writing = next.clone();
        if let Ok(runtime) = Handle::try_current() {
            drop(runtime.spawn(next.clone()));
        }
        next
    }

    fn later(self: &Arc<Self>, state: &mut State) {
        if state.timer.is_some() {
            return;
        }
        let Ok(runtime) = Handle::try_current() else {
            return;
        };
        let delay = std::time::Duration::from_millis(self.options.flush_ms);
        let weak: Weak<Inner> = Arc::downgrade(self);
        let sleep = tokio::time::sleep(delay);
        state.timer = Some(runtime.spawn(async move {
            sleep.await;
            if let Some(inner) = weak.upgrade() {
                inner.state.lock().timer = None;
                inner.flush().await;
            }
        }));
    }

    fn add(self: &Arc<Self>, token_id: &str, call: ScriptTokenCall, at: i64) {
        let mut state = self.state.lock();
        if state.gone.contains(token_id) {
            return;
        }
        let outcome = call.outcome;
        let rings = self.loaded(&mut state);
        let index = match rings.iter().position(|(id, _)| id == token_id) {
            Some(index) => index,
            None => {
                rings.push((token_id.to_owned(), Ring::default()));
                rings.len() - 1
            }
        };
        let ring = &mut rings[index].1;
        ring.push(call);
        ring.count(at, outcome);
        self.later(&mut state);
    }
}

#[derive(Clone)]
pub struct ScriptTokenUsageLog {
    inner: Arc<Inner>,
}

pub struct ConnectionRelease {
    inner: Arc<Inner>,
    token_id: String,
    key: u64,
}

impl Drop for ConnectionRelease {
    fn drop(&mut self) {
        self.release();
    }
}

impl ConnectionRelease {
    pub fn release(&self) {
        let mut state = self.inner.state.lock();
        let Some(open) = state.connections.get_mut(&self.token_id) else {
            return;
        };
        open.remove(&self.key);
        if open.is_empty() {
            state.connections.remove(&self.token_id);
        }
    }
}

impl ScriptTokenUsageLog {
    pub fn new(path: PathBuf, options: UsageLogOptions) -> Self {
        let idle: BoxFuture<'static, ()> = async {}.boxed();
        Self {
            inner: Arc::new(Inner {
                path,
                options,
                state: Mutex::new(State {
                    rings: None,
                    connections: HashMap::new(),
                    gone: HashSet::new(),
                    timer: None,
                    writing: idle.shared(),
                    next_key: 0,
                    writes: 0,
                }),
                landed: Arc::new(Mutex::new(0)),
            }),
        }
    }

    pub fn record(&self, token_id: &str, call: UsageCall) {
        let at = (self.inner.options.now)();
        self.inner.add(
            token_id,
            ScriptTokenCall {
                at: iso_time(at),
                method: call.method,
                target: call.target,
                outcome: call.outcome,
                code: call.code.filter(|code| !code.is_empty()),
            },
            at,
        );
    }

    pub fn regenerated(&self, token_id: &str) {
        self.inner.state.lock().connections.remove(token_id);
        let at = (self.inner.options.now)();
        self.inner.add(
            token_id,
            ScriptTokenCall {
                at: iso_time(at),
                method: String::new(),
                target: ScriptTokenCallTarget::default(),
                outcome: ScriptTokenCallOutcome::Regenerated,
                code: None,
            },
            at,
        );
    }

    pub fn connected(&self, token_id: &str, source: ConnectionSource) -> ConnectionRelease {
        let mut state = self.inner.state.lock();
        let key = state.next_key;
        state.next_key += 1;
        state
            .connections
            .entry(token_id.to_owned())
            .or_default()
            .insert(key, source);
        ConnectionRelease {
            inner: Arc::clone(&self.inner),
            token_id: token_id.to_owned(),
            key,
        }
    }

    pub fn clear(&self, token_id: &str) {
        let mut state = self.inner.state.lock();
        state.gone.insert(token_id.to_owned());
        state.connections.remove(token_id);
        let rings = self.inner.loaded(&mut state);
        let before = rings.len();
        rings.retain(|(id, _)| id != token_id);
        if rings.len() != before {
            self.inner.later(&mut state);
        }
    }

    pub fn usage(&self, token_id: &str) -> UsageSnapshot {
        let mut state = self.inner.state.lock();
        let now = (self.inner.options.now)();
        let rings = self.inner.loaded(&mut state);
        let ring = rings
            .iter()
            .find(|(id, _)| id == token_id)
            .map(|(_, ring)| ring);
        let since = now.div_euclid(HOUR_MS) - (HOURS as i64 - 1);
        let (mut calls, mut refused_calls) = (0_i64, 0_i64);
        for bucket in ring.iter().flat_map(|ring| ring.hours.iter().flatten()) {
            if bucket.0 < since {
                continue;
            }
            calls += bucket.1;
            refused_calls += bucket.2;
        }
        let history = ring
            .map(|ring| ring.calls.iter().rev().cloned().collect())
            .unwrap_or_default();
        let connections = state
            .connections
            .get(token_id)
            .map(|open| {
                open.values()
                    .map(|source| ConnectionSource {
                        pid: source.pid.filter(|pid| *pid != 0),
                    })
                    .collect()
            })
            .unwrap_or_default();
        UsageSnapshot {
            calls: history,
            connections,
            last24h: Last24h {
                calls: u64::try_from(calls).unwrap_or(0),
                refused: u64::try_from(refused_calls).unwrap_or(0),
            },
        }
    }

    pub fn flush(&self) -> Shared<BoxFuture<'static, ()>> {
        self.inner.flush()
    }

    pub fn close(&self) {
        let mut state = self.inner.state.lock();
        Inner::cancel(&mut state);
        let Some(out) = self.inner.snapshot(&state) else {
            return;
        };
        state.writes += 1;
        let sequence = state.writes;
        let mut newest = self.inner.landed.lock();
        match write_compact(&self.inner.path, &out) {
            Ok(()) => *newest = sequence,
            Err(err) => tracing::error!("[script-token-usage] close write failed: {err}"),
        }
    }
}

pub async fn usage_view(
    log: &ScriptTokenUsageLog,
    token_id: &str,
    lookups: Option<&UsageLookups>,
) -> ScriptTokenUsage {
    let usage = log.usage(token_id);
    let mut names = UsageNames::default();
    let Some(lookups) = lookups else {
        return with_names(usage, names);
    };
    let targets = usage.calls.iter().map(|call| &call.target);
    let workspace_ids: HashSet<&str> = targets
        .clone()
        .filter_map(|target| target.workspace_id.as_deref())
        .collect();
    let pane_ids: HashSet<&str> = targets
        .filter_map(|target| target.pane_id.as_deref())
        .collect();
    let listing = (!workspace_ids.is_empty()).then(|| (lookups.listing)());
    let panes = lookups
        .panes
        .as_ref()
        .filter(|_| !pane_ids.is_empty())
        .map(|lookup| lookup());
    let (listing, panes) = join(
        async {
            match listing {
                Some(pending) => pending.await.map_or_else(|_| Vec::new(), |l| l.workspaces),
                None => Vec::new(),
            }
        },
        async {
            match panes {
                Some(pending) => pending.await.unwrap_or_default(),
                None => Vec::new(),
            }
        },
    )
    .await;
    for workspace in listing {
        if workspace_ids.contains(workspace.workspace_id.as_str()) {
            names
                .workspaces
                .insert(workspace.workspace_id, workspace.name);
        }
    }
    for pane in panes {
        if pane_ids.contains(pane.pane_id.as_str()) {
            names.panes.insert(pane.pane_id, pane.title);
        }
    }
    with_names(usage, names)
}

fn with_names(usage: UsageSnapshot, names: UsageNames) -> ScriptTokenUsage {
    ScriptTokenUsage {
        calls: usage.calls,
        connections: usage.connections,
        last24h: usage.last24h,
        names,
    }
}
