use std::path::{Path, PathBuf};

use ostia_base::Result;
use ostia_base::host::Host;
use ostia_base::json_store::{SaveOptions, StoreScope, load_json, save_json, store_path};
use ostia_contract::install_method::{InstallMethod, replaces_in_app};
use ostia_contract::releases::UpdateChannel;

use crate::install_replace::PendingSweep;

pub fn pending_sweep_path(host: &Host) -> PathBuf {
    store_path(host, "install-replace", StoreScope::Global, None)
}

pub fn save_pending_sweep(path: &Path, pending: Option<&PendingSweep>) -> Result<()> {
    save_json(path, &pending, SaveOptions::default())
}

pub fn load_pending_sweep(path: &Path) -> Option<PendingSweep> {
    let raw = load_json(path)?;
    let record = raw.as_object()?;
    Some(PendingSweep {
        app_dir: PathBuf::from(record.get("appDir")?.as_str()?),
        version: record.get("version")?.as_str()?.to_owned(),
    })
}

pub fn update_dir(
    method: InstallMethod,
    channel: UpdateChannel,
    app_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    if replaces_in_app(method, channel) {
        app_dir
    } else {
        None
    }
}
