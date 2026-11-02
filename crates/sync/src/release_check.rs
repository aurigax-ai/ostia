use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use ostia_base::PRODUCT_NAME;
use ostia_base::clock::{Clock, system_clock};
use ostia_base::events::EventHub;
use ostia_base::host::Host;
use ostia_base::js::non_empty;
use ostia_base::json_store::{SaveOptions, StoreScope, load_json, save_json, store_path};
use ostia_contract::build_info::{is_dirty_build, release_version};
use ostia_contract::install_method::{
    InstallMethod, ReleaseState, ReplaceAvailability, ReplaceStart, ReplaceState, UpdateRunStart,
    UpdateRunState, is_mac_install, update_channel_for, update_command_line,
};
use ostia_contract::releases::{
    AssetName, ParsedRelease, RELEASE_API_BASE_URL, RELEASE_NAME, RELEASE_OWNER, ReleaseInfo,
    UpdateChannel, dmg_asset_name, is_newer_version, parse_latest_release, parse_update_channel,
    parse_version, pick_beta_release, pick_main_channel_release, tarball_asset_name,
};
use parking_lot::Mutex;
use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::{Client, Response};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::install_replace::InstallReplacer;
use crate::update_run::UpdateRunner;

const RELEASE_CHECK_STARTUP_DELAY: Duration = Duration::from_secs(5);
pub const RELEASE_CHECK_INTERVAL_MS: i64 = 60 * 60 * 1000;
pub const RELEASE_CHECK_RETRY_MS: i64 = 60 * 60 * 1000;
const RELEASE_CHECK_TICK: Duration = Duration::from_secs(60);
const RELEASE_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RELEASE_RESPONSE_MAX_BYTES: usize = 1024 * 1024;
pub const RELEASE_API_URL_ENV: &str = "RELEASE_API_URL";
const RELEASE_LIST_PAGE_SIZE: usize = 100;
const RELEASE_LIST_MAX_PAGES: usize = 4;
const LATEST_PATH: &str = "releases/latest";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseCheckError {
    Offline,
    RateLimited,
    Unavailable,
}

impl ReleaseCheckError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::RateLimited => "rate-limited",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReleaseCheckResult {
    Available { release: ReleaseInfo },
    Latest { version: String },
    Error { error: ReleaseCheckError },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LatestRelease {
    Release(ReleaseInfo),
    None,
    Error(ReleaseCheckError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseCheckTrigger {
    Auto,
    Manual,
}

impl ReleaseCheckTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseEndpoint {
    pub base_url: String,
    pub automatic: bool,
}

pub fn release_endpoint(is_packaged: bool, host: &Host) -> ReleaseEndpoint {
    let overridden = if is_packaged {
        None
    } else {
        host.app_var(RELEASE_API_URL_ENV)
    };
    ReleaseEndpoint {
        base_url: overridden.unwrap_or(RELEASE_API_BASE_URL).to_owned(),
        automatic: is_packaged || overridden.is_some(),
    }
}

fn behavior_field<'a>(settings: &'a Value, name: &str) -> Option<&'a Value> {
    settings.get("behavior")?.as_object()?.get(name)
}

pub fn read_check_for_updates(settings: &Value) -> bool {
    behavior_field(settings, "checkForUpdates") != Some(&Value::Bool(false))
}

pub fn read_update_channel(settings: &Value) -> UpdateChannel {
    parse_update_channel(behavior_field(settings, "updateChannel").unwrap_or(&Value::Null))
}

pub fn release_user_agent(version: &str) -> String {
    format!("{PRODUCT_NAME}/{version}")
}

fn read_release(text: &str, query: &Query) -> LatestRelease {
    let Ok(raw) = serde_json::from_str::<Value>(text) else {
        return LatestRelease::Error(ReleaseCheckError::Unavailable);
    };
    match query.parse(&raw) {
        ParsedRelease::Release(release) => LatestRelease::Release(release),
        ParsedRelease::NotStable => LatestRelease::None,
        ParsedRelease::Malformed => LatestRelease::Error(ReleaseCheckError::Unavailable),
    }
}

enum Query {
    Latest,
    Main,
    Beta(AssetName),
}

impl Query {
    fn for_channel(channel: UpdateChannel, beta_asset: AssetName) -> Self {
        match channel {
            UpdateChannel::Main => Self::Main,
            UpdateChannel::Beta => Self::Beta(beta_asset),
            UpdateChannel::Stable => Self::Latest,
        }
    }

    fn path(&self) -> String {
        match self {
            Self::Latest => LATEST_PATH.to_owned(),
            Self::Main | Self::Beta(_) => format!("releases?per_page={RELEASE_LIST_PAGE_SIZE}"),
        }
    }

    fn parse(&self, raw: &Value) -> ParsedRelease {
        match self {
            Self::Latest => parse_latest_release(raw),
            Self::Main => pick_main_channel_release(raw),
            Self::Beta(asset) => pick_beta_release(raw, *asset),
        }
    }
}

enum PageText {
    Text(String),
    Done(LatestRelease),
}

async fn read_capped(
    mut response: Response,
    max_bytes: usize,
) -> Result<Option<String>, reqwest::Error> {
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > max_bytes {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(String::from_utf8_lossy(&body).into_owned()))
}

async fn request_page(
    client: &Client,
    url: String,
    user_agent: &str,
) -> Result<PageText, reqwest::Error> {
    let response = client
        .get(url)
        .header(USER_AGENT, user_agent)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await?;
    let status = response.status().as_u16();
    if status == 404 {
        return Ok(PageText::Done(LatestRelease::None));
    }
    if status == 403 || status == 429 {
        return Ok(PageText::Done(LatestRelease::Error(
            ReleaseCheckError::RateLimited,
        )));
    }
    if status != 200 {
        return Ok(PageText::Done(LatestRelease::Error(
            ReleaseCheckError::Unavailable,
        )));
    }
    let text = read_capped(response, RELEASE_RESPONSE_MAX_BYTES).await?;
    Ok(PageText::Text(text.unwrap_or_default()))
}

async fn fetch_page(client: &Client, options: &FetchLatestOptions, path: &str) -> PageText {
    let url = format!(
        "{}/repos/{RELEASE_OWNER}/{RELEASE_NAME}/{path}",
        options.base_url
    );
    let timeout = options.timeout.unwrap_or(RELEASE_REQUEST_TIMEOUT);
    match tokio::time::timeout(timeout, request_page(client, url, &options.user_agent)).await {
        Ok(Ok(page)) => page,
        _ => PageText::Done(LatestRelease::Error(ReleaseCheckError::Offline)),
    }
}

fn is_full_page(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|list| list.as_array().map(Vec::len))
        .is_some_and(|len| len >= RELEASE_LIST_PAGE_SIZE)
}

pub struct FetchLatestOptions {
    pub base_url: String,
    pub user_agent: String,
    pub channel: UpdateChannel,
    pub beta_asset: Option<AssetName>,
    pub timeout: Option<Duration>,
}

pub async fn fetch_latest_release(options: FetchLatestOptions) -> LatestRelease {
    let query = Query::for_channel(
        options.channel,
        options.beta_asset.unwrap_or(dmg_asset_name),
    );
    let Ok(client) = Client::builder().redirect(Policy::none()).build() else {
        return LatestRelease::Error(ReleaseCheckError::Offline);
    };
    let pages = if matches!(query, Query::Latest) {
        1
    } else {
        RELEASE_LIST_MAX_PAGES
    };
    let mut result = LatestRelease::None;
    for page in 1..=pages {
        let path = if page == 1 {
            query.path()
        } else {
            format!("{}&page={page}", query.path())
        };
        match fetch_page(&client, &options, &path).await {
            PageText::Done(done) => return done,
            PageText::Text(text) => {
                result = read_release(&text, &query);
                if matches!(result, LatestRelease::Release(_)) || !is_full_page(&text) {
                    return result;
                }
            }
        }
    }
    result
}

pub type LatestFuture = Pin<Box<dyn Future<Output = LatestRelease> + Send>>;
pub type AvailabilityFuture = Pin<Box<dyn Future<Output = Option<ReplaceAvailability>> + Send>>;
pub type CheckFuture = Shared<Pin<Box<dyn Future<Output = ReleaseCheckResult> + Send>>>;

pub type ChangeFn = dyn Fn(Option<&ReleaseInfo>) + Send + Sync;
pub type CheckLogFn = dyn Fn(ReleaseCheckTrigger, &str, Option<&str>) + Send + Sync;
pub type InfoLogFn = dyn Fn(&str, Value) + Send + Sync;

pub struct ReleaseCheckerDeps {
    pub current_version: String,
    pub fetch_latest: Box<dyn Fn(UpdateChannel) -> LatestFuture + Send + Sync>,
    pub now: Clock,
    pub enabled: Box<dyn Fn() -> bool + Send + Sync>,
    pub channel: Box<dyn Fn() -> UpdateChannel + Send + Sync>,
    pub load_dismissed: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub save_dismissed: Box<dyn Fn(&str) + Send + Sync>,
    pub on_change: Box<ChangeFn>,
    pub log: Option<Box<CheckLogFn>>,
}

struct CheckerState {
    available: Option<ReleaseInfo>,
    dismissed: Option<String>,
    published: Option<String>,
    next_auto_at: i64,
    channel: UpdateChannel,
}

struct CheckerInner {
    deps: ReleaseCheckerDeps,
    state: Mutex<CheckerState>,
    running: Mutex<Option<CheckFuture>>,
}

#[derive(Clone)]
pub struct ReleaseChecker {
    inner: Arc<CheckerInner>,
}

type Publication = Option<Option<ReleaseInfo>>;

fn pending_of(state: &CheckerState) -> Option<ReleaseInfo> {
    let available = state.available.as_ref()?;
    match non_empty(state.dismissed.as_deref()) {
        Some(dismissed) if !is_newer_version(&available.version, dismissed) => None,
        _ => Some(available.clone()),
    }
}

fn publication_of(state: &mut CheckerState) -> Publication {
    let next = pending_of(state);
    let version = next.as_ref().map(|release| release.version.clone());
    if version == state.published {
        return None;
    }
    state.published = version;
    Some(next)
}

impl ReleaseChecker {
    pub fn new(deps: ReleaseCheckerDeps) -> Self {
        let state = CheckerState {
            available: None,
            dismissed: (deps.load_dismissed)(),
            published: None,
            next_auto_at: 0,
            channel: (deps.channel)(),
        };
        Self {
            inner: Arc::new(CheckerInner {
                deps,
                state: Mutex::new(state),
                running: Mutex::new(None),
            }),
        }
    }

    pub fn available(&self) -> Option<ReleaseInfo> {
        self.inner.state.lock().available.clone()
    }

    pub fn pending(&self) -> Option<ReleaseInfo> {
        pending_of(&self.inner.state.lock())
    }

    fn announce(&self, publication: Publication) {
        if let Some(next) = publication {
            (self.inner.deps.on_change)(next.as_ref());
        }
    }

    fn log(&self, trigger: ReleaseCheckTrigger, outcome: &str, latest: Option<&str>) {
        if let Some(log) = &self.inner.deps.log {
            log(trigger, outcome, latest);
        }
    }

    pub fn check(&self, trigger: ReleaseCheckTrigger) -> CheckFuture {
        let mut running = self.inner.running.lock();
        if let Some(existing) = running.as_ref() {
            return existing.clone();
        }
        let work = self.run(trigger);
        let checker = self.clone();
        let shared = (Box::pin(async move {
            let result = work.await;
            checker.inner.running.lock().take();
            result
        }) as Pin<Box<dyn Future<Output = ReleaseCheckResult> + Send>>)
            .shared();
        *running = Some(shared.clone());
        shared
    }

    fn run(
        &self,
        trigger: ReleaseCheckTrigger,
    ) -> Pin<Box<dyn Future<Output = ReleaseCheckResult> + Send>> {
        let channel = (self.inner.deps.channel)();
        self.inner.state.lock().channel = channel;
        let fetching = (self.inner.deps.fetch_latest)(channel);
        let checker = self.clone();
        Box::pin(async move { checker.finish(trigger, fetching.await) })
    }

    fn finish(&self, trigger: ReleaseCheckTrigger, latest: LatestRelease) -> ReleaseCheckResult {
        let deps = &self.inner.deps;
        if let LatestRelease::Error(error) = latest {
            let now = (deps.now)();
            self.inner.state.lock().next_auto_at = now + RELEASE_CHECK_RETRY_MS;
            self.log(trigger, error.as_str(), None);
            return ReleaseCheckResult::Error { error };
        }
        let now = (deps.now)();
        let newer = match &latest {
            LatestRelease::Release(release)
                if is_newer_version(&release.version, &deps.current_version) =>
            {
                Some(release.clone())
            }
            _ => None,
        };
        let publication = {
            let mut state = self.inner.state.lock();
            state.next_auto_at = now + RELEASE_CHECK_INTERVAL_MS;
            state.available = newer.clone();
            publication_of(&mut state)
        };
        self.announce(publication);
        let seen = match &latest {
            LatestRelease::Release(release) => Some(release.version.as_str()),
            _ => None,
        };
        self.log(
            trigger,
            if newer.is_some() {
                "available"
            } else {
                "latest"
            },
            seen,
        );
        match newer {
            Some(release) => ReleaseCheckResult::Available { release },
            None => ReleaseCheckResult::Latest {
                version: deps.current_version.clone(),
            },
        }
    }

    pub fn tick(&self) -> impl Future<Output = ()> + Send + use<> {
        let next_auto_at = self.inner.state.lock().next_auto_at;
        let due = (self.inner.deps.now)() >= next_auto_at && (self.inner.deps.enabled)();
        let check = due.then(|| self.check(ReleaseCheckTrigger::Auto));
        async move {
            if let Some(check) = check {
                check.await;
            }
        }
    }

    pub fn dismiss(&self) {
        let (version, publication) = {
            let mut state = self.inner.state.lock();
            let Some(available) = state.available.as_ref() else {
                return;
            };
            let version = available.version.clone();
            state.dismissed = Some(version.clone());
            (version, publication_of(&mut state))
        };
        self.announce(publication);
        (self.inner.deps.save_dismissed)(&version);
    }

    pub fn settings_changed(&self) -> impl Future<Output = ()> + Send + use<> {
        let channel = (self.inner.deps.channel)();
        let publication = {
            let mut state = self.inner.state.lock();
            if state.channel == channel {
                None
            } else {
                state.channel = channel;
                state.available = None;
                state.next_auto_at = 0;
                Some(publication_of(&mut state))
            }
        };
        let tick = publication.map(|publication| {
            self.announce(publication);
            self.tick()
        });
        async move {
            if let Some(tick) = tick {
                tick.await;
            }
        }
    }
}

pub struct ReleaseSchedule {
    tasks: [JoinHandle<()>; 2],
}

impl Drop for ReleaseSchedule {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

pub fn spawn_release_schedule(checker: &ReleaseChecker) -> ReleaseSchedule {
    let startup = tokio::time::sleep(RELEASE_CHECK_STARTUP_DELAY);
    let mut ticks =
        tokio::time::interval_at(Instant::now() + RELEASE_CHECK_TICK, RELEASE_CHECK_TICK);
    let first = checker.clone();
    let second = checker.clone();
    ReleaseSchedule {
        tasks: [
            tokio::spawn(async move {
                startup.await;
                first.tick().await;
            }),
            tokio::spawn(async move {
                loop {
                    ticks.tick().await;
                    tokio::spawn(second.tick());
                }
            }),
        ],
    }
}

pub fn dismissed_store_path(host: &Host) -> PathBuf {
    store_path(host, "release-check", StoreScope::Global, None)
}

pub fn save_dismissed(path: &Path, version: &str) -> ostia_base::Result<()> {
    save_json(
        path,
        &json!({"dismissedVersion": version}),
        SaveOptions::default(),
    )
}

pub fn load_dismissed(path: &Path) -> Option<String> {
    let stored = load_json(path)?;
    let version = stored.get("dismissedVersion")?.as_str()?;
    parse_version(version).map(|_| version.to_owned())
}

pub struct ReleaseServiceDeps {
    pub open_external: Box<dyn Fn(&str) -> bool + Send + Sync>,
    pub read_settings: Box<dyn Fn() -> Value + Send + Sync>,
    pub log_info: Box<InfoLogFn>,
    pub log_warn: Box<dyn Fn(&str) + Send + Sync>,
    pub version: String,
    pub method: Box<dyn Fn() -> InstallMethod + Send + Sync>,
    pub update_runner: UpdateRunner,
    pub replace_availability: Box<dyn Fn() -> AvailabilityFuture + Send + Sync>,
    pub replacer: InstallReplacer,
    pub is_packaged: bool,
    pub host: Host,
}

struct ServiceShared {
    deps: ReleaseServiceDeps,
    events: EventHub<ReleaseState>,
}

async fn state_of(shared: &ServiceShared, pending: Option<ReleaseInfo>) -> ReleaseState {
    let method = (shared.deps.method)();
    let replace = if pending.is_some() {
        (shared.deps.replace_availability)().await
    } else {
        None
    };
    ReleaseState {
        release: pending,
        method,
        update_command: update_command_line(method),
        replace,
    }
}

pub struct ReleaseService {
    checker: ReleaseChecker,
    shared: Arc<ServiceShared>,
    _schedule: Option<ReleaseSchedule>,
}

impl ReleaseService {
    pub fn start(deps: ReleaseServiceDeps) -> Self {
        let ReleaseEndpoint {
            base_url,
            automatic,
        } = release_endpoint(deps.is_packaged, &deps.host);
        let current_version = release_version(&deps.version).to_owned();
        let dirty = is_dirty_build(&deps.version);
        let store = dismissed_store_path(&deps.host);
        let shared = Arc::new(ServiceShared {
            deps,
            events: EventHub::default(),
        });
        let (changes, mut pending_changes) = tokio::sync::mpsc::unbounded_channel();
        let checker = ReleaseChecker::new(ReleaseCheckerDeps {
            current_version: current_version.clone(),
            fetch_latest: Box::new({
                let shared = Arc::clone(&shared);
                let user_agent = release_user_agent(&current_version);
                move |channel: UpdateChannel| -> LatestFuture {
                    let beta_asset: AssetName = if is_mac_install((shared.deps.method)()) {
                        dmg_asset_name
                    } else {
                        tarball_asset_name
                    };
                    Box::pin(fetch_latest_release(FetchLatestOptions {
                        base_url: base_url.clone(),
                        user_agent: user_agent.clone(),
                        channel,
                        beta_asset: Some(beta_asset),
                        timeout: None,
                    }))
                }
            }),
            now: system_clock(),
            enabled: Box::new({
                let shared = Arc::clone(&shared);
                move || read_check_for_updates(&(shared.deps.read_settings)())
            }),
            channel: Box::new({
                let shared = Arc::clone(&shared);
                move || {
                    update_channel_for(
                        (shared.deps.method)(),
                        read_update_channel(&(shared.deps.read_settings)()),
                        dirty,
                    )
                }
            }),
            load_dismissed: Box::new({
                let store = store.clone();
                move || load_dismissed(&store)
            }),
            save_dismissed: Box::new({
                let shared = Arc::clone(&shared);
                move |version: &str| {
                    if save_dismissed(&store, version).is_err() {
                        (shared.deps.log_warn)("release-dismiss-unsaved");
                    }
                }
            }),
            on_change: Box::new(move |pending: Option<&ReleaseInfo>| {
                let _ = changes.send(pending.cloned());
            }),
            log: Some(Box::new({
                let shared = Arc::clone(&shared);
                move |trigger: ReleaseCheckTrigger, outcome: &str, latest: Option<&str>| {
                    let mut fields = json!({"trigger": trigger.as_str(), "outcome": outcome});
                    if let (Some(latest), Some(fields)) = (latest, fields.as_object_mut()) {
                        fields.insert("latest".to_owned(), Value::String(latest.to_owned()));
                    }
                    (shared.deps.log_info)("release-check", fields);
                }
            })),
        });
        tokio::spawn({
            let shared = Arc::clone(&shared);
            async move {
                while let Some(pending) = pending_changes.recv().await {
                    let state = state_of(&shared, pending).await;
                    shared.events.emit(state);
                }
            }
        });
        let schedule = automatic.then(|| spawn_release_schedule(&checker));
        Self {
            checker,
            shared,
            _schedule: schedule,
        }
    }

    pub fn subscribe(&self) -> tokio::sync::mpsc::UnboundedReceiver<ReleaseState> {
        self.shared.events.subscribe()
    }

    pub fn release_state(&self) -> impl Future<Output = ReleaseState> + Send + use<> {
        let pending = self.checker.pending();
        let shared = Arc::clone(&self.shared);
        async move { state_of(&shared, pending).await }
    }

    pub fn release_check(&self) -> CheckFuture {
        self.checker.check(ReleaseCheckTrigger::Manual)
    }

    pub fn release_dismiss(&self) {
        self.checker.dismiss();
    }

    pub fn release_open(&self) -> bool {
        match self.checker.available() {
            Some(release) => (self.shared.deps.open_external)(&release.url),
            None => false,
        }
    }

    pub fn install_replace(&self) -> ReplaceStart {
        match self.checker.available() {
            Some(release) => self.shared.deps.replacer.start(release),
            None => ReplaceStart::NoAction,
        }
    }

    pub fn install_replace_state(&self) -> ReplaceState {
        self.shared.deps.replacer.state()
    }

    pub fn update_run(&self) -> impl Future<Output = UpdateRunStart> + Send + use<> {
        self.shared.deps.update_runner.start()
    }

    pub fn update_run_state(&self) -> UpdateRunState {
        self.shared.deps.update_runner.state()
    }

    pub fn settings_changed(&self) {
        tokio::spawn(self.checker.settings_changed());
    }
}
