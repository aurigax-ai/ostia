use std::sync::Arc;

use ostia_contract::sandbox::SandboxMergeRefusal;
use serde::{Serialize, Serializer};
use serde_json::{Value, json};

pub type OwnerWindowFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type HasManagerFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type SandboxRefusalFn = Arc<dyn Fn(&str, &str) -> Option<SandboxMergeRefusal> + Send + Sync>;
pub type RecheckFn<'a> = &'a dyn Fn() -> WorkspaceMergeResult;
pub type MergeFn =
    Arc<dyn for<'a> Fn(&str, &str, RecheckFn<'a>) -> WorkspaceMergeResult + Send + Sync>;

#[derive(Clone)]
pub struct MergeChecks {
    pub owner_window: OwnerWindowFn,
    pub has_manager: HasManagerFn,
    pub sandbox_refusal: SandboxRefusalFn,
}

#[derive(Clone)]
pub struct WorkspaceMerge {
    pub checks: MergeChecks,
    pub merge: MergeFn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceMergeRefusal {
    NotOwned,
    Manager,
    Sandbox(SandboxMergeRefusal),
}

impl WorkspaceMergeRefusal {
    fn text(self) -> &'static str {
        match self {
            Self::NotOwned => "not-owned",
            Self::Manager => "manager",
            Self::Sandbox(SandboxMergeRefusal::Mixed) => "sandbox-mixed",
            Self::Sandbox(SandboxMergeRefusal::Differs) => "sandbox-differs",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceMergeResult {
    Allowed,
    Refused(WorkspaceMergeRefusal),
}

impl Serialize for WorkspaceMergeResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let body = match self {
            Self::Allowed => json!({"ok": true}),
            Self::Refused(refusal) => json!({"ok": false, "error": refusal.text()}),
        };
        body.serialize(serializer)
    }
}

pub fn check_merge(
    checks: &MergeChecks,
    window_id: &str,
    source_id: &Value,
    target_id: &Value,
) -> WorkspaceMergeResult {
    let (Some(source), Some(target)) = (source_id.as_str(), target_id.as_str()) else {
        return WorkspaceMergeResult::Refused(WorkspaceMergeRefusal::NotOwned);
    };
    let owned = |id: &str| (checks.owner_window)(id).as_deref() == Some(window_id);
    if source == target || !owned(source) || !owned(target) {
        return WorkspaceMergeResult::Refused(WorkspaceMergeRefusal::NotOwned);
    }
    if (checks.has_manager)(source) || (checks.has_manager)(target) {
        return WorkspaceMergeResult::Refused(WorkspaceMergeRefusal::Manager);
    }
    match (checks.sandbox_refusal)(source, target) {
        Some(refusal) => WorkspaceMergeResult::Refused(WorkspaceMergeRefusal::Sandbox(refusal)),
        None => WorkspaceMergeResult::Allowed,
    }
}

pub fn merge_workspaces(
    service: &WorkspaceMerge,
    window_id: &str,
    source_id: &Value,
    target_id: &Value,
) -> WorkspaceMergeResult {
    let (Some(source), Some(target)) = (source_id.as_str(), target_id.as_str()) else {
        return WorkspaceMergeResult::Refused(WorkspaceMergeRefusal::NotOwned);
    };
    let recheck = || check_merge(&service.checks, window_id, source_id, target_id);
    (service.merge)(source, target, &recheck)
}
