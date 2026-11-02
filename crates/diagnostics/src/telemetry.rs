use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_base::clock::{Clock, system_clock};
use ostia_base::host::Host;
use ostia_base::json_store::load_json;
use ostia_contract::build_info::TelemetryStamp;
use serde_json::{Map, Value};
use tokio::time::{Instant, MissedTickBehavior, interval_at};

use crate::app_log::redact_secrets;
use crate::diagnostics::ErrorTelemetry;
use crate::privacy_telemetry::{
    ErrorInput, InstallContext, ReportContext, TELEMETRY_CATEGORIES, TELEMETRY_URL_ENV,
    TelemetryCategory, TelemetryEndpoint, TelemetrySettings, build_error_report, is_value_word,
    iso_timestamp, parse_ingest, parse_telemetry_settings, platform_name,
};
use crate::telemetry_queue::{
    LogSink, PostTransport, TelemetryQueue, TelemetryQueueDeps, http_transport, new_install_id,
    parse_stored,
};
use crate::telemetry_usage::{SessionFacts, TelemetryUsage, TelemetryUsageDeps};

pub const TELEMETRY_FILE: &str = "telemetry.json";
const USAGE_INTERVAL: Duration = Duration::from_secs(30 * 60);
const QUIT_TIMEOUT: Duration = Duration::from_secs(2);
const FLUSH_DELAY: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_secs(60);

pub fn telemetry_endpoint(
    packaged: bool,
    env: &BTreeMap<String, String>,
    stamp: Option<&TelemetryStamp>,
) -> Option<TelemetryEndpoint> {
    let override_url = if packaged {
        None
    } else {
        env.get(&format!("OSTIA_{TELEMETRY_URL_ENV}"))
            .filter(|value| !value.is_empty())
    };
    if let Some(url) = override_url {
        return parse_ingest(url, "");
    }
    stamp.and_then(|stamp| parse_ingest(&stamp.host, &stamp.key))
}

pub fn read_telemetry_settings(settings: &Value) -> TelemetrySettings {
    let Some(privacy) = settings.get("privacy").filter(|value| value.is_object()) else {
        return TelemetrySettings::default();
    };
    parse_telemetry_settings(privacy.get("telemetry").unwrap_or(&Value::Null))
}

fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

pub fn install_context(version: &str, locale: &str, packaged: bool) -> InstallContext {
    InstallContext {
        app_version: version.to_owned(),
        electron_version: String::new(),
        os_name: platform_name().to_owned(),
        os_version: rustix::system::uname()
            .release()
            .to_string_lossy()
            .into_owned(),
        arch: arch_name().to_owned(),
        locale: if is_value_word(locale) { locale } else { "en" }.to_owned(),
        channel: if packaged { "packaged" } else { "source" }.to_owned(),
    }
}

pub struct TelemetryDeps {
    pub file: PathBuf,
    pub endpoint: Option<TelemetryEndpoint>,
    pub context: Arc<dyn Fn() -> InstallContext + Send + Sync>,
    pub settings: Arc<dyn Fn() -> TelemetrySettings + Send + Sync>,
    pub session: Arc<dyn Fn() -> SessionFacts + Send + Sync>,
    pub transport: Arc<dyn PostTransport>,
    pub now: Clock,
    pub new_id: Arc<dyn Fn() -> String + Send + Sync>,
    pub log: Option<LogSink>,
    pub flush_delay: Duration,
    pub retry_delay: Duration,
    pub usage_interval: Duration,
}

impl TelemetryDeps {
    pub fn new(
        file: PathBuf,
        endpoint: Option<TelemetryEndpoint>,
        context: Arc<dyn Fn() -> InstallContext + Send + Sync>,
        settings: Arc<dyn Fn() -> TelemetrySettings + Send + Sync>,
        session: Arc<dyn Fn() -> SessionFacts + Send + Sync>,
    ) -> Self {
        Self {
            file,
            endpoint,
            context,
            settings,
            session,
            transport: http_transport(),
            now: system_clock(),
            new_id: Arc::new(|| uuid::Uuid::new_v4().simple().to_string()),
            log: None,
            flush_delay: FLUSH_DELAY,
            retry_delay: RETRY_DELAY,
            usage_interval: USAGE_INTERVAL,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TelemetryState {
    pub install_id: String,
    pub asked: bool,
    pub available: bool,
    pub new_categories: Vec<TelemetryCategory>,
}

#[derive(Debug, Clone)]
pub struct TelemetryReports {
    pub queued: Vec<Value>,
    pub sent: Vec<Value>,
}

struct TelemetryInner {
    queue: TelemetryQueue,
    usage: Arc<TelemetryUsage>,
    settings: Arc<dyn Fn() -> TelemetrySettings + Send + Sync>,
    now: Clock,
    report_context: Arc<dyn Fn() -> ReportContext + Send + Sync>,
    usage_timer: parking_lot::Mutex<Option<tokio::task::AbortHandle>>,
}

#[derive(Clone)]
pub struct Telemetry {
    inner: Arc<TelemetryInner>,
}

fn new_categories(asked: bool, seen: &[TelemetryCategory]) -> Vec<TelemetryCategory> {
    if !asked {
        return Vec::new();
    }
    TELEMETRY_CATEGORIES
        .into_iter()
        .filter(|category| !seen.contains(category))
        .collect()
}

impl Telemetry {
    pub fn new(deps: TelemetryDeps) -> Self {
        let raw = load_json(&deps.file).unwrap_or_else(|| Value::Object(Map::new()));
        let stored = parse_stored(&raw);
        let started_at = (deps.now)();
        let queue = TelemetryQueue::new(
            TelemetryQueueDeps {
                file: deps.file,
                endpoint: deps.endpoint,
                context: deps.context.clone(),
                settings: deps.settings.clone(),
                transport: deps.transport,
                log: deps.log,
                flush_delay: deps.flush_delay,
                retry_delay: deps.retry_delay,
            },
            stored,
        );
        let report_context: Arc<dyn Fn() -> ReportContext + Send + Sync> = {
            let queue = queue.clone();
            let context = deps.context;
            let now = deps.now.clone();
            let new_id = deps.new_id;
            Arc::new(move || ReportContext {
                install_id: queue.read(|stored| stored.install_id.clone()),
                context: context(),
                now: now.clone(),
                new_id: new_id.clone(),
                redact: Arc::new(|text: &str| redact_secrets(text)),
            })
        };
        let enqueue: Arc<dyn Fn(Value) + Send + Sync> = {
            let queue = queue.clone();
            Arc::new(move |report| queue.enqueue(report))
        };
        let usage = Arc::new(TelemetryUsage::new(
            TelemetryUsageDeps {
                settings: deps.settings.clone(),
                session: deps.session,
            },
            deps.now.clone(),
            started_at,
            report_context.clone(),
            enqueue,
        ));
        let usage_timer = start_usage_timer(&usage, deps.usage_interval);
        Self {
            inner: Arc::new(TelemetryInner {
                queue,
                usage,
                settings: deps.settings,
                now: deps.now,
                report_context,
                usage_timer: parking_lot::Mutex::new(usage_timer),
            }),
        }
    }

    pub fn error(&self, input: ErrorInput) {
        if !(self.inner.settings)().get(TelemetryCategory::Errors) {
            return;
        }
        let context = (self.inner.report_context)();
        self.inner
            .queue
            .enqueue(build_error_report(&input, &context));
    }

    pub fn count(&self, category: &str, key: &str, id: Option<&str>) {
        self.inner.usage.count(category, key, id);
    }

    pub fn state(&self) -> TelemetryState {
        let (install_id, asked, categories) = self.inner.queue.read(|stored| {
            (
                stored.install_id.clone(),
                stored.asked,
                new_categories(stored.asked, &stored.seen),
            )
        });
        TelemetryState {
            install_id,
            asked,
            available: self.inner.queue.has_endpoint(),
            new_categories: categories,
        }
    }

    pub fn consented(&self) {
        let answered_at = iso_timestamp((self.inner.now)());
        self.inner.queue.update(|stored| {
            stored.asked = true;
            stored.answered_at = Some(answered_at);
            stored.seen = TELEMETRY_CATEGORIES.to_vec();
            true
        });
    }

    pub fn categories_seen(&self) {
        self.inner.queue.update(|stored| {
            if new_categories(stored.asked, &stored.seen).is_empty() {
                return false;
            }
            stored.seen = TELEMETRY_CATEGORIES.to_vec();
            true
        });
    }

    pub fn reset_install_id(&self) -> String {
        let id = new_install_id();
        let fresh = id.clone();
        self.inner.queue.update(|stored| {
            stored.install_id = fresh;
            stored.queue.clear();
            stored.sent.clear();
            true
        });
        self.inner.usage.reset();
        id
    }

    pub fn reports(&self) -> TelemetryReports {
        self.inner.queue.read(|stored| TelemetryReports {
            queued: stored
                .queue
                .iter()
                .map(|queued| queued.report.clone())
                .collect(),
            sent: stored.sent.clone(),
        })
    }

    pub fn settings_changed(&self) {
        self.inner.queue.drop_kind();
    }

    pub fn flush(&self) -> BoxFuture<'static, ()> {
        self.inner.queue.flush()
    }

    pub fn shutdown(&self) -> BoxFuture<'static, ()> {
        if !self.inner.queue.begin_shutdown() {
            return Box::pin(std::future::ready(()));
        }
        if let Some(timer) = self.inner.usage_timer.lock().take() {
            timer.abort();
        }
        self.inner.usage.take();
        if !self.inner.queue.has_endpoint() || self.inner.queue.queue_is_empty() {
            return Box::pin(std::future::ready(()));
        }
        let flush = self.inner.queue.flush();
        let deadline = tokio::time::sleep(QUIT_TIMEOUT);
        Box::pin(async move {
            tokio::select! {
                () = flush => {}
                () = deadline => {}
            }
        })
    }
}

impl ErrorTelemetry for Telemetry {
    fn error(&self, input: ErrorInput) {
        Telemetry::error(self, input);
    }
}

fn start_usage_timer(
    usage: &Arc<TelemetryUsage>,
    period: Duration,
) -> Option<tokio::task::AbortHandle> {
    let runtime = tokio::runtime::Handle::try_current().ok()?;
    let period = period.max(Duration::from_millis(1));
    let mut ticker = interval_at(Instant::now() + period, period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let weak = Arc::downgrade(usage);
    let task = runtime.spawn(async move {
        loop {
            ticker.tick().await;
            let Some(usage) = weak.upgrade() else {
                return;
            };
            usage.take();
        }
    });
    Some(task.abort_handle())
}

pub struct RegisterTelemetryDeps {
    pub file: PathBuf,
    pub version: String,
    pub stamp: Option<TelemetryStamp>,
    pub read_settings: Arc<dyn Fn() -> Value + Send + Sync>,
    pub locale: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    pub session: Arc<dyn Fn() -> SessionFacts + Send + Sync>,
    pub log: Option<LogSink>,
    pub packaged: bool,
    pub host: Host,
}

pub fn register_telemetry(deps: RegisterTelemetryDeps) -> Telemetry {
    let version = deps.version;
    let locale = deps.locale;
    let packaged = deps.packaged;
    let read_settings = deps.read_settings;
    let endpoint = telemetry_endpoint(packaged, &deps.host.env, deps.stamp.as_ref());
    let mut telemetry_deps = TelemetryDeps::new(
        deps.file,
        endpoint,
        Arc::new(move || install_context(&version, locale().as_deref().unwrap_or("en"), packaged)),
        Arc::new(move || read_telemetry_settings(&read_settings())),
        deps.session,
    );
    telemetry_deps.log = deps.log;
    Telemetry::new(telemetry_deps)
}
