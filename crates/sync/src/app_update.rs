use ostia_contract::build_info::{BuildInfo, same_build};
use parking_lot::Mutex;

pub const UPDATE_POLL_MS: u64 = 30_000;

pub struct UpdateWatcherDeps {
    pub current: BuildInfo,
    pub read: Box<dyn Fn() -> Option<BuildInfo> + Send + Sync>,
    pub on_update: Box<dyn Fn(&BuildInfo) + Send + Sync>,
}

pub struct UpdateWatcher {
    deps: UpdateWatcherDeps,
    announced: Mutex<Option<BuildInfo>>,
}

impl UpdateWatcher {
    pub fn new(deps: UpdateWatcherDeps) -> Self {
        Self {
            deps,
            announced: Mutex::new(None),
        }
    }

    pub fn check(&self) -> Option<BuildInfo> {
        let disk = (self.deps.read)()?;
        if same_build(&disk, &self.deps.current) {
            return None;
        }
        {
            let mut announced = self.announced.lock();
            if let Some(known) = announced.as_ref()
                && same_build(&disk, known)
            {
                return Some(known.clone());
            }
            *announced = Some(disk.clone());
        }
        (self.deps.on_update)(&disk);
        Some(disk)
    }

    pub fn available(&self) -> Option<BuildInfo> {
        self.announced.lock().clone()
    }
}

pub fn without_telemetry(info: &BuildInfo) -> BuildInfo {
    BuildInfo {
        version: info.version.clone(),
        built_at: info.built_at.clone(),
        telemetry: None,
        server: None,
    }
}
