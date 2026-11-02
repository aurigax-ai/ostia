use std::fs;
use std::future::Future;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Weak};

use ostia_base::js::static_regex;
use ostia_base::random::random_bytes;
use ostia_base::{Error, Result};
use parking_lot::Mutex;
use regex::Regex;
use rustix::process::{Pid, test_kill_process};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use tokio::sync::oneshot::error::TryRecvError;

use crate::history_feed::{Closing, HistoryFeed, SpillClient, SpillPressure};
use crate::history_records::{HistoryKey, new_history_key};
use crate::pane_history::{PaneHistory, PaneHistoryDeps, errno_code};
use crate::scrollback_history::ScrollbackHistory;

pub const HISTORY_DIR: &str = "scrollback";
pub const FREE_SPACE_FLOOR: u64 = 2 * 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

static RUN_DIR: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^([0-9]+)-[0-9a-f]+$"));

fn pid_alive(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
        return false;
    };
    match test_kill_process(pid) {
        Ok(()) => true,
        Err(err) => err == rustix::io::Errno::PERM,
    }
}

pub fn sweep_history_root(root: &Path, own_pid: u32) {
    if !root.exists() {
        return;
    }
    let _ = fs::set_permissions(root, fs::Permissions::from_mode(0o700));
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let pid = RUN_DIR
            .captures(&name)
            .and_then(|found| found.get(1))
            .and_then(|digits| digits.as_str().parse::<u64>().ok());
        let run = RUN_DIR.is_match(&name);
        if run {
            let alive = pid.is_some_and(|value| {
                u32::try_from(value).is_ok_and(|small| small == own_pid || pid_alive(small))
            });
            if alive {
                continue;
            }
        }
        let path = entry.path();
        let removed = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(err) = removed {
            tracing::warn!(code = %errno_code(&err), "history-sweep-failed");
        }
    }
}

fn pane_folder(pane_id: &str) -> String {
    let digest = hex::encode(Sha256::digest(pane_id.as_bytes()).as_slice());
    digest[..24].to_string()
}

type Setting = Arc<dyn Fn() -> ScrollbackHistory + Send + Sync>;
type StartSpill = Arc<dyn Fn() -> SpillClient + Send + Sync>;
type FreeBytes = Arc<dyn Fn(&Path) -> u64 + Send + Sync>;
type OnFailed = Arc<dyn Fn(&str, &str) + Send + Sync>;

#[derive(Clone)]
pub struct PaneHistoriesDeps {
    pub root: PathBuf,
    pub setting: Setting,
    pub start_spill: StartSpill,
    pub free_bytes: Option<FreeBytes>,
    pub on_failed: Option<OnFailed>,
    pub segment_bytes: Option<u64>,
}

fn statfs_free(dir: &Path) -> u64 {
    rustix::fs::statvfs(dir).map_or(0, |stats| stats.f_bavail.saturating_mul(stats.f_frsize))
}

struct Inner {
    key: HistoryKey,
    run_dir: PathBuf,
    deps: PaneHistoriesDeps,
    panes: Mutex<Vec<(String, PaneHistory)>>,
    spill: Mutex<Option<SpillClient>>,
    generation: AtomicU64,
    disposing: Mutex<Vec<oneshot::Receiver<()>>>,
    closing: Mutex<Vec<(String, u64, Closing)>>,
    close_serial: AtomicU64,
}

#[derive(Clone)]
pub struct PaneHistories {
    inner: Arc<Inner>,
}

impl PaneHistories {
    pub fn new(deps: PaneHistoriesDeps) -> Self {
        sweep_history_root(&deps.root, std::process::id());
        let run_dir = deps.root.join(format!(
            "{}-{}",
            std::process::id(),
            hex::encode(random_bytes::<4>())
        ));
        Self {
            inner: Arc::new(Inner {
                key: new_history_key(),
                run_dir,
                deps,
                panes: Mutex::new(Vec::new()),
                spill: Mutex::new(None),
                generation: AtomicU64::new(0),
                disposing: Mutex::new(Vec::new()),
                closing: Mutex::new(Vec::new()),
                close_serial: AtomicU64::new(0),
            }),
        }
    }

    pub fn get(&self, pane_id: &str) -> Option<PaneHistory> {
        self.inner
            .panes
            .lock()
            .iter()
            .find(|(id, _)| id == pane_id)
            .map(|(_, history)| history.clone())
    }

    pub fn for_pane(&self, pane_id: &str) -> Option<PaneHistory> {
        let existing = self.get(pane_id);
        if let Some(history) = existing {
            if history.live() {
                return Some(history);
            }
            self.retire(&history);
            self.inner.panes.lock().retain(|(id, _)| id != pane_id);
        }
        if (self.inner.deps.setting)() == ScrollbackHistory::Off {
            return None;
        }
        let weak = Arc::downgrade(&self.inner);
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst);
        let history = PaneHistory::new(PaneHistoryDeps {
            dir: self
                .inner
                .run_dir
                .join(format!("{}-{generation}", pane_folder(pane_id))),
            key: self.inner.key,
            limit_bytes: {
                let weak = weak.clone();
                Arc::new(move || weak.upgrade().and_then(|inner| inner.limit_bytes()))
            },
            ensure_space: {
                let weak = weak.clone();
                Arc::new(move |asking| {
                    weak.upgrade()
                        .is_some_and(|inner| inner.ensure_space(asking))
                })
            },
            on_failed: {
                let weak = weak.clone();
                let pane = pane_id.to_string();
                Arc::new(move |reason| {
                    if let Some(inner) = weak.upgrade()
                        && let Some(on_failed) = &inner.deps.on_failed
                    {
                        on_failed(&pane, reason);
                    }
                })
            },
            segment_bytes: self.inner.deps.segment_bytes,
        });
        self.inner
            .panes
            .lock()
            .push((pane_id.to_string(), history.clone()));
        Some(history)
    }

    pub fn feed_for(
        &self,
        pane_id: &str,
        cols: u16,
        rows: u16,
        pressure: Option<Arc<dyn SpillPressure>>,
    ) -> Option<HistoryFeed> {
        let history = self.for_pane(pane_id)?;
        let client = {
            let mut spill = self.inner.spill.lock();
            match spill.as_ref().filter(|client| client.alive()) {
                Some(client) => client.clone(),
                None => {
                    let started = (self.inner.deps.start_spill)();
                    *spill = Some(started.clone());
                    started
                }
            }
        };
        let feed = client.open(&history, cols, rows, pressure);
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let pane = pane_id.to_string();
        Some(feed.with_close_hook(Arc::new(move |closing: &Closing| {
            if let Some(inner) = weak.upgrade() {
                let serial = inner.close_serial.fetch_add(1, Ordering::SeqCst);
                let mut list = inner.closing.lock();
                list.retain(|(id, _, _)| id != &pane);
                list.push((pane.clone(), serial, closing.clone()));
            }
        })))
    }

    pub fn settled(&self, pane_id: &str) -> impl Future<Output = ()> + Send + use<> {
        let pending = self
            .inner
            .closing
            .lock()
            .iter()
            .find(|(id, _, _)| id == pane_id)
            .map(|(_, serial, closing)| (*serial, closing.clone()));
        let weak = Arc::downgrade(&self.inner);
        let pane = pane_id.to_string();
        async move {
            if let Some((serial, closing)) = pending {
                closing.wait().await;
                if let Some(inner) = weak.upgrade() {
                    inner
                        .closing
                        .lock()
                        .retain(|(id, current, _)| !(id == &pane && *current == serial));
                }
            }
        }
    }

    pub fn drop_pane(&self, pane_id: &str) {
        let removed = {
            let mut panes = self.inner.panes.lock();
            panes
                .iter()
                .position(|(id, _)| id == pane_id)
                .map(|index| panes.remove(index).1)
        };
        if let Some(history) = removed {
            self.retire(&history);
        }
    }

    pub async fn remove_all(&self) -> Result<()> {
        let histories: Vec<PaneHistory> = std::mem::take(&mut *self.inner.panes.lock())
            .into_iter()
            .map(|(_, history)| history)
            .collect();
        for history in &histories {
            self.retire(history);
        }
        let waiting = std::mem::take(&mut *self.inner.disposing.lock());
        for receiver in waiting {
            let _ = receiver.await;
        }
        match fs::remove_dir_all(&self.inner.run_dir) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(Error::Io {
                path: self.inner.run_dir.clone(),
                source,
            }),
        }
    }

    fn retire(&self, history: &PaneHistory) {
        let receiver = history.start_dispose();
        let mut disposing = self.inner.disposing.lock();
        disposing.retain_mut(|pending| matches!(pending.try_recv(), Err(TryRecvError::Empty)));
        disposing.push(receiver);
    }
}

impl Inner {
    fn limit_bytes(&self) -> Option<u64> {
        match (self.deps.setting)() {
            ScrollbackHistory::Unlimited => None,
            ScrollbackHistory::Off => Some(0),
            ScrollbackHistory::Mib(size) => Some(size * MIB),
        }
    }

    fn ensure_space(&self, asking: &PaneHistory) -> bool {
        if (self.deps.setting)() == ScrollbackHistory::Off {
            return false;
        }
        if let Err(err) = fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.run_dir)
        {
            asking.fail(&errno_code(&err));
            return false;
        }
        let free_bytes: FreeBytes = self
            .deps
            .free_bytes
            .clone()
            .unwrap_or_else(|| Arc::new(statfs_free));
        loop {
            if free_bytes(&self.run_dir) >= FREE_SPACE_FLOOR {
                return true;
            }
            let mut candidates: Vec<PaneHistory> = self
                .panes
                .lock()
                .iter()
                .map(|(_, history)| history.clone())
                .filter(PaneHistory::droppable)
                .collect();
            candidates.sort_by_key(|history| std::cmp::Reverse(history.bytes()));
            let Some(largest) = candidates.into_iter().next() else {
                return false;
            };
            largest.drop_oldest_segment();
            if largest.same_as(asking) && !asking.droppable() {
                return false;
            }
        }
    }
}

pub async fn remove_histories(histories: Option<&PaneHistories>, warn: &dyn Fn(&str, &str)) {
    let Some(histories) = histories else {
        return;
    };
    if let Err(err) = histories.remove_all().await {
        let code = match &err {
            Error::Io { source, .. } => errno_code(source),
            _ => "unknown".to_string(),
        };
        warn("history-remove-failed", &code);
    }
}
