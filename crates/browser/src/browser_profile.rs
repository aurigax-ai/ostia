use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserProfile {
    Shared,
    Isolated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserOpener {
    Human,
    Agent,
}

pub const SHARED_BROWSER_PARTITION: &str = "persist:ostia-browser";

const ISOLATED_PREFIX: &str = "ostia-browser-";

fn isolated_browser_partition(pane_id: &str) -> String {
    format!("{ISOLATED_PREFIX}{pane_id}")
}

pub fn browser_partition(profile: BrowserProfile, pane_id: &str) -> String {
    match profile {
        BrowserProfile::Shared => SHARED_BROWSER_PARTITION.to_owned(),
        BrowserProfile::Isolated => isolated_browser_partition(pane_id),
    }
}

pub fn is_isolated_browser_partition(partition: Option<&str>) -> bool {
    partition.is_some_and(|value| value.starts_with(ISOLATED_PREFIX))
}

pub fn parse_browser_profile(raw: &Value) -> BrowserProfile {
    if raw.as_str() == Some("shared") {
        BrowserProfile::Shared
    } else {
        BrowserProfile::Isolated
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BrowserProfileContext {
    pub opener: BrowserOpener,
    pub scratch: bool,
    pub sandboxed: bool,
}

pub fn browser_profile_for(ctx: BrowserProfileContext) -> BrowserProfile {
    if ctx.opener != BrowserOpener::Human || ctx.scratch || ctx.sandboxed {
        BrowserProfile::Isolated
    } else {
        BrowserProfile::Shared
    }
}
