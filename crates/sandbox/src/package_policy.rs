use futures_util::future::BoxFuture;

use crate::packages::{PackageRef, package_key, package_version_key};

const DAY_MS: i64 = 24 * 3_600_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackagePolicy {
    pub malware: bool,
    pub cooldown_days: i64,
    pub deny_list: Vec<String>,
    pub allow_only: Option<Vec<String>>,
    pub allowances: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MalwareCheck {
    Clean,
    Malicious,
    Unavailable,
}

pub trait PackageLookups: Send + Sync {
    fn malware(&self, pkg: &PackageRef) -> BoxFuture<'static, MalwareCheck>;
    fn published_at(&self, pkg: &PackageRef) -> BoxFuture<'static, Option<i64>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageBlockReason {
    DenyList,
    NotAllowed,
    Malware,
    OsvUnavailable,
    Cooldown,
}

impl PackageBlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DenyList => "deny-list",
            Self::NotAllowed => "not-allowed",
            Self::Malware => "malware",
            Self::OsvUnavailable => "osv-unavailable",
            Self::Cooldown => "cooldown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageDecision {
    Allow,
    Block(PackageBlockReason),
}

pub async fn decide_package<L: PackageLookups + ?Sized>(
    pkg: &PackageRef,
    policy: &PackagePolicy,
    lookups: &L,
    now: i64,
) -> PackageDecision {
    let key = package_key(pkg);
    if policy.deny_list.contains(&key) {
        return PackageDecision::Block(PackageBlockReason::DenyList);
    }
    if let Some(only) = &policy.allow_only
        && !only.contains(&key)
    {
        return PackageDecision::Block(PackageBlockReason::NotAllowed);
    }
    let allowed = policy.allowances.contains(&package_version_key(pkg));
    if policy.malware {
        match lookups.malware(pkg).await {
            MalwareCheck::Malicious => return PackageDecision::Block(PackageBlockReason::Malware),
            MalwareCheck::Unavailable if !allowed => {
                return PackageDecision::Block(PackageBlockReason::OsvUnavailable);
            }
            _ => {}
        }
    }
    if allowed {
        return PackageDecision::Allow;
    }
    if policy.cooldown_days > 0
        && let Some(published) = lookups.published_at(pkg).await
        && now.saturating_sub(published) < policy.cooldown_days.saturating_mul(DAY_MS)
    {
        return PackageDecision::Block(PackageBlockReason::Cooldown);
    }
    PackageDecision::Allow
}
