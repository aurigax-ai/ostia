use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_base::WorkspaceId;
use ostia_contract::sandbox::{BrowserControl, host_matches};
use url::Url;

#[derive(Clone, Debug)]
pub struct BrowserPolicy {
    pub browser: BrowserControl,
    pub domains: Vec<String>,
    pub denied: Vec<String>,
}

#[derive(Clone)]
pub struct BrowserFenceDeps {
    pub policy: Arc<dyn Fn(&WorkspaceId) -> Option<BrowserPolicy> + Send + Sync>,
    pub request_domain: Arc<dyn Fn(&WorkspaceId, &str) -> BoxFuture<'static, bool> + Send + Sync>,
}

#[derive(Clone)]
pub struct BrowserFence {
    deps: BrowserFenceDeps,
}

struct Target {
    host: String,
    port: u16,
}

fn parse(url: &str) -> Option<Target> {
    let parsed = Url::parse(url).ok()?;
    let fallback = match parsed.scheme() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    Some(Target {
        host: parsed.host_str()?.to_owned(),
        port: parsed.port().unwrap_or(fallback),
    })
}

impl BrowserFence {
    pub fn new(deps: BrowserFenceDeps) -> Self {
        Self { deps }
    }

    pub fn allowed_now(&self, workspace_id: &WorkspaceId, url: &str) -> bool {
        let Some(policy) = (self.deps.policy)(workspace_id) else {
            return true;
        };
        if policy.browser == BrowserControl::Unrestricted {
            return true;
        }
        let Some(target) = parse(url) else {
            return false;
        };
        if host_matches(&target.host, target.port, &policy.denied) {
            return false;
        }
        host_matches(&target.host, target.port, &policy.domains)
    }

    pub fn check(&self, workspace_id: &WorkspaceId, url: &str) -> BoxFuture<'static, bool> {
        if self.allowed_now(workspace_id, url) {
            return std::future::ready(true).boxed();
        }
        let Some(target) = parse(url) else {
            return std::future::ready(false).boxed();
        };
        let denied = (self.deps.policy)(workspace_id)
            .map(|policy| policy.denied)
            .unwrap_or_default();
        if host_matches(&target.host, target.port, &denied) {
            return std::future::ready(false).boxed();
        }
        let asked = (self.deps.request_domain)(workspace_id, &target.host);
        let fence = self.clone();
        let workspace_id = workspace_id.clone();
        let url = url.to_owned();
        async move { asked.await && fence.allowed_now(&workspace_id, &url) }.boxed()
    }
}
