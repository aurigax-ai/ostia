use std::path::PathBuf;

use crate::install_replace::{PendingSweep, sweep_old_install};
use crate::mac_replace::discard_staged;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SweepWarning {
    InstallSweepFailed,
    UpdateStagedDiscardFailed,
}

impl SweepWarning {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InstallSweepFailed => "install-sweep-failed",
            Self::UpdateStagedDiscardFailed => "update-staged-discard-failed",
        }
    }
}

pub struct LaunchSweep {
    pub pending: Option<PendingSweep>,
    pub app_dir: Option<PathBuf>,
    pub version: String,
    pub mac_install: bool,
    pub swept: Box<dyn Fn() + Send + Sync>,
    pub warn: Box<dyn Fn(SweepWarning) + Send + Sync>,
}

pub async fn sweep_update_leftovers(sweep: LaunchSweep) {
    let old = async {
        match sweep_old_install(
            sweep.pending.as_ref(),
            sweep.app_dir.as_deref(),
            &sweep.version,
        )
        .await
        {
            Ok(true) => (sweep.swept)(),
            Ok(false) => {}
            Err(_) => (sweep.warn)(SweepWarning::InstallSweepFailed),
        }
    };
    let staged = async {
        if let (true, Some(app_dir)) = (sweep.mac_install, sweep.app_dir.as_deref())
            && discard_staged(app_dir).await.is_err()
        {
            (sweep.warn)(SweepWarning::UpdateStagedDiscardFailed);
        }
    };
    tokio::join!(old, staged);
}
