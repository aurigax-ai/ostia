use std::path::PathBuf;

use ostia_contract::osc7::is_host_named;

use crate::extension_agents::workspace_folder;

type WorkspaceLookup<T> = Box<dyn Fn(&str) -> T + Send + Sync>;

#[derive(Clone)]
pub struct CwdReport {
    pub host: String,
    pub path: String,
}

pub struct PaneIdentity {
    pub pane_id: String,
    pub workspace_id: String,
    pub manager: bool,
}

#[derive(Debug, PartialEq)]
pub struct TrustPlace {
    pub folder: PathBuf,
    pub work_dir: PathBuf,
    pub home: PathBuf,
}

pub struct TrustPlaceDeps {
    pub home: PathBuf,
    pub hostname: Option<String>,
    pub work_dir_of: WorkspaceLookup<Option<String>>,
    pub cwd_report: WorkspaceLookup<Option<CwdReport>>,
    pub is_scratch: WorkspaceLookup<bool>,
    pub sandbox_enabled: WorkspaceLookup<bool>,
}

pub fn trust_place_of(
    deps: &TrustPlaceDeps,
    identity: &PaneIdentity,
    scratch_dir: Option<&str>,
) -> Option<TrustPlace> {
    if identity.manager {
        return None;
    }
    let workspace = identity.workspace_id.as_str();
    if (deps.sandbox_enabled)(workspace) {
        return None;
    }
    let scratch_dir = scratch_dir.filter(|dir| !dir.is_empty());
    if (deps.is_scratch)(workspace) && scratch_dir.is_none() {
        return None;
    }
    let work_dir = match scratch_dir {
        Some(dir) => PathBuf::from(dir),
        None => workspace_folder((deps.work_dir_of)(workspace).as_deref(), &deps.home)?,
    };
    let report = (deps.cwd_report)(&identity.pane_id)?;
    if !is_host_named(&report.host, deps.hostname.as_deref()) {
        return None;
    }
    Some(TrustPlace {
        folder: PathBuf::from(report.path),
        work_dir,
        home: deps.home.clone(),
    })
}
