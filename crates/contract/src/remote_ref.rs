use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;

static REMOTE_REF: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^remote:([A-Za-z0-9][A-Za-z0-9._-]{0,252}):([0-9a-f]{8})$"));
static PANE_ID: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9a-f]{8}$"));

const DESKTOP_PREFIX: &str = "desktop:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRef {
    pub host: String,
    pub pane: String,
}

pub fn remote_ref(host: &str, pane: &str) -> String {
    format!("remote:{host}:{pane}")
}

pub fn parse_remote_ref(text: &str) -> Option<RemoteRef> {
    let captures = REMOTE_REF.captures(text)?;
    Some(RemoteRef {
        host: captures[1].to_owned(),
        pane: captures[2].to_owned(),
    })
}

pub fn remote_route(host: &str) -> String {
    format!("remote:{host}")
}

pub fn is_pane_id(text: &str) -> bool {
    PANE_ID.is_match(text)
}

pub fn desktop_ref(pane: &str) -> String {
    format!("{DESKTOP_PREFIX}{pane}")
}

pub fn parse_desktop_ref(text: &str) -> Option<String> {
    text.strip_prefix(DESKTOP_PREFIX)
        .filter(|rest| !rest.is_empty())
        .map(str::to_owned)
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

pub fn offline_notice(host: &str, since: &str, waiting: usize) -> String {
    format!(
        "{host} is offline since {since}; {waiting} message{} wait and go when it is back.",
        plural(waiting)
    )
}

pub fn back_notice(host: &str, delivered: usize, expired: usize) -> String {
    format!(
        "{host} is back; {delivered} message{} delivered, {expired} expired.",
        plural(delivered)
    )
}
