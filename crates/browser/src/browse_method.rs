use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ostia_base::path_guard::resolve_safe;
use ostia_base::private_tmp::private_tmp_dir;
use ostia_base::{Host, PRODUCT_NAME, PaneId, Result, WindowId, WorkspaceId};
use ostia_control::identity::PaneIdentity;
use ostia_diagnostics::error_report::{ErrorSink, Thrown};
use serde_json::{Value, json};
use tokio::time::{Instant, sleep};

const DEFAULT_TIMEOUT_MS: f64 = 25_000.0;
pub const MAX_TIMEOUT_MS: f64 = 120_000.0;
const POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandTarget {
    pub window_id: Option<WindowId>,
    pub workspace_id: WorkspaceId,
    pub pane_id: Option<PaneId>,
}

pub fn fail(error: &str, message: Option<&str>) -> Value {
    match message.filter(|message| !message.is_empty()) {
        Some(message) => json!({"ok": false, "error": error, "message": message}),
        None => json!({"ok": false, "error": error}),
    }
}

pub fn str_of(value: &Value) -> Option<&str> {
    value.as_str()
}

pub fn num_of(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

pub fn clamp_timeout(value: &Value) -> f64 {
    num_of(value)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(0.0, MAX_TIMEOUT_MS)
}

pub fn command_target(identity: &PaneIdentity) -> CommandTarget {
    CommandTarget {
        window_id: Some(identity.window_id.clone()),
        workspace_id: identity.workspace_id.clone(),
        pane_id: Some(identity.pane_id.clone()),
    }
}

pub fn wait_for<'a, F, Fut>(
    mut check: F,
    timeout_ms: f64,
    errors: &'a ErrorSink,
) -> impl Future<Output = bool> + 'a
where
    F: FnMut() -> Fut + 'a,
    Fut: Future<Output = std::result::Result<bool, Thrown>> + 'a,
{
    let wait = Duration::try_from_secs_f64(timeout_ms / 1000.0).unwrap_or(Duration::ZERO);
    let deadline = Instant::now() + wait;
    let first = check();
    async move {
        let mut failure: Option<Thrown> = None;
        let mut pending = Some(first);
        loop {
            let attempt = match pending.take() {
                Some(attempt) => attempt,
                None => check(),
            };
            match attempt.await {
                Ok(true) => return true,
                Ok(false) => {}
                Err(thrown) => failure = Some(thrown),
            }
            if Instant::now() >= deadline {
                if let Some(thrown) = failure {
                    errors.report("browseWait", &thrown);
                }
                return false;
            }
            sleep(POLL).await;
        }
    }
}

pub fn safe_out_path(screenshot_roots: &[String], path: &str, host: &Host) -> Option<PathBuf> {
    let roots: Vec<&str> = screenshot_roots.iter().map(String::as_str).collect();
    resolve_safe(path, &roots, host)
}

pub type NowMs = Arc<dyn Fn() -> u64 + Send + Sync>;

#[derive(Clone)]
pub struct ScratchPaths {
    host: Host,
    now: NowMs,
    counter: Arc<AtomicU64>,
}

impl ScratchPaths {
    pub fn new(host: Host, now: NowMs) -> Self {
        Self {
            host,
            now,
            counter: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn path(&self, prefix: &str, ext: &str) -> Result<PathBuf> {
        let number = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let folder = private_tmp_dir(&self.host, &format!("{PRODUCT_NAME}-screens"))?;
        Ok(folder.join(format!("{prefix}-{}-{number}.{ext}", (self.now)())))
    }
}

pub fn write_out(path: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, data)
}
