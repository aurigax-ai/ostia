use std::sync::Arc;

use ostia_base::clock::Clock;
use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::privacy_telemetry::{
    ReportContext, TELEMETRY_COUNTS_MAX, TELEMETRY_LIST_MAX, TelemetryCategory, TelemetrySettings,
    UsageCounts, UsageKeyKind, any_telemetry_on, build_usage_report, empty_usage_counts,
    is_count_id, is_value_word, usage_key_kind,
};

#[derive(Debug, Clone)]
pub struct SessionFacts {
    pub windows: String,
    pub workspaces: String,
    pub restore: String,
    pub in_effect: Vec<(String, Vec<(String, String)>)>,
    pub installed_extensions: Vec<String>,
    pub enabled_extensions: Vec<String>,
}

pub struct TelemetryUsageDeps {
    pub settings: Arc<dyn Fn() -> TelemetrySettings + Send + Sync>,
    pub session: Arc<dyn Fn() -> SessionFacts + Send + Sync>,
}

struct UsageState {
    sent_at: i64,
    counts: UsageCounts,
    start_reported: bool,
}

pub struct TelemetryUsage {
    deps: TelemetryUsageDeps,
    now: Clock,
    report_context: Arc<dyn Fn() -> ReportContext + Send + Sync>,
    enqueue: Arc<dyn Fn(Value) + Send + Sync>,
    state: Mutex<UsageState>,
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

fn set_value(counts: &mut UsageCounts, category: TelemetryCategory, key: &str, value: Value) {
    if usage_key_kind(category, key) != Some(UsageKeyKind::Value) {
        return;
    }
    if let Value::String(text) = &value
        && !is_value_word(text)
    {
        return;
    }
    if let Some(map) = counts.category_mut(category) {
        map.insert(key.to_owned(), value);
    }
}

fn set_list(counts: &mut UsageCounts, category: TelemetryCategory, key: &str, values: &[String]) {
    if usage_key_kind(category, key) != Some(UsageKeyKind::List) {
        return;
    }
    let listed: Vec<Value> = values
        .iter()
        .filter(|value| is_count_id(value))
        .take(TELEMETRY_LIST_MAX)
        .map(|value| Value::from(value.as_str()))
        .collect();
    if let Some(map) = counts.category_mut(category) {
        map.insert(key.to_owned(), Value::Array(listed));
    }
}

impl TelemetryUsage {
    pub fn new(
        deps: TelemetryUsageDeps,
        now: Clock,
        started_at: i64,
        report_context: Arc<dyn Fn() -> ReportContext + Send + Sync>,
        enqueue: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Self {
        Self {
            deps,
            now,
            report_context,
            enqueue,
            state: Mutex::new(UsageState {
                sent_at: started_at,
                counts: empty_usage_counts(),
                start_reported: false,
            }),
        }
    }

    fn session_facts(
        &self,
        state: &mut UsageState,
        settings: &TelemetrySettings,
        facts: &SessionFacts,
    ) {
        let now = (self.now)();
        if settings.get(TelemetryCategory::Usage) {
            if !state.start_reported {
                state
                    .counts
                    .usage
                    .insert("app_starts".to_owned(), Value::from(1));
                state.start_reported = true;
            }
            let minutes = js_round((now - state.sent_at) as f64 / 60_000.0);
            set_value(
                &mut state.counts,
                TelemetryCategory::Usage,
                "session_minutes",
                Value::from(minutes),
            );
            for (key, value) in [
                ("windows", &facts.windows),
                ("workspaces", &facts.workspaces),
                ("restore", &facts.restore),
            ] {
                set_value(
                    &mut state.counts,
                    TelemetryCategory::Usage,
                    key,
                    Value::from(value.as_str()),
                );
            }
        }
        for (name, values) in &facts.in_effect {
            let Some(category) = TelemetryCategory::parse_usage(name) else {
                continue;
            };
            if !settings.get(category) {
                continue;
            }
            for (key, value) in values {
                set_value(
                    &mut state.counts,
                    category,
                    key,
                    Value::from(value.as_str()),
                );
            }
        }
        if settings.get(TelemetryCategory::Extensions) {
            set_list(
                &mut state.counts,
                TelemetryCategory::Extensions,
                "installed",
                &facts.installed_extensions,
            );
            set_list(
                &mut state.counts,
                TelemetryCategory::Extensions,
                "enabled",
                &facts.enabled_extensions,
            );
        }
    }

    pub fn take(&self) {
        let settings = (self.deps.settings)();
        let mut sendable = settings;
        sendable.set(TelemetryCategory::Errors, false);
        if !any_telemetry_on(&sendable) {
            let mut state = self.state.lock();
            state.counts = empty_usage_counts();
            state.sent_at = (self.now)();
            return;
        }
        let facts = (self.deps.session)();
        let context = (self.report_context)();
        let report = {
            let mut state = self.state.lock();
            self.session_facts(&mut state, &settings, &facts);
            let report = build_usage_report(&state.counts, &settings, &context);
            state.counts = empty_usage_counts();
            state.sent_at = (self.now)();
            report
        };
        (self.enqueue)(report);
    }

    pub fn count(&self, category: &str, key: &str, id: Option<&str>) {
        let Some(category) = TelemetryCategory::parse_usage(category) else {
            return;
        };
        let Some(kind) = usage_key_kind(category, key) else {
            return;
        };
        if kind != UsageKeyKind::Count && kind != UsageKeyKind::Ids {
            return;
        }
        if !(self.deps.settings)().get(category) {
            return;
        }
        let mut state = self.state.lock();
        let Some(map) = state.counts.category_mut(category) else {
            return;
        };
        if kind == UsageKeyKind::Count {
            if id.is_some() {
                return;
            }
            let current = map.get(key).and_then(Value::as_i64).unwrap_or(0);
            map.insert(key.to_owned(), Value::from(current + 1));
            return;
        }
        let Some(id) = id.filter(|id| is_count_id(id)) else {
            return;
        };
        let mut bucket: Map<String, Value> = match map.get(key) {
            Some(Value::Object(existing)) => existing.clone(),
            _ => Map::new(),
        };
        if !bucket.contains_key(id) && bucket.len() >= TELEMETRY_COUNTS_MAX {
            return;
        }
        let seen = bucket.get(id).and_then(Value::as_i64).unwrap_or(0);
        bucket.insert(id.to_owned(), Value::from(seen + 1));
        map.insert(key.to_owned(), Value::Object(bucket));
    }

    pub fn reset(&self) {
        self.state.lock().counts = empty_usage_counts();
    }
}
