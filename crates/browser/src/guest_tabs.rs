use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use url::Url;

pub const TAB_REFERRER_MS: i64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferrerPolicy {
    Default,
    NoReferrer,
    NoReferrerWhenDowngrade,
    Origin,
    OriginWhenCrossOrigin,
    SameOrigin,
    StrictOrigin,
    StrictOriginWhenCrossOrigin,
    UnsafeUrl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Referrer {
    pub url: String,
    pub policy: ReferrerPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserTabOpen {
    pub guest_id: u32,
    pub url: String,
    pub background: bool,
}

pub trait TabHost: Send + Sync {
    fn id(&self) -> u32;
    fn is_destroyed(&self) -> bool;
    fn send_open_tab(&self, open: BrowserTabOpen);
}

#[derive(Clone)]
pub struct TabGuest {
    pub id: u32,
    pub host: Option<Arc<dyn TabHost>>,
}

fn origin_of(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()
        .map(|parsed| parsed.origin().ascii_serialization())
}

pub fn is_tab_url(url: &str) -> bool {
    let bytes = url.as_bytes();
    let scheme_len = if bytes.len() >= 8 && bytes[..5].eq_ignore_ascii_case(b"https") {
        5
    } else if bytes.len() >= 7 && bytes[..4].eq_ignore_ascii_case(b"http") {
        4
    } else {
        return false;
    };
    bytes[scheme_len..].starts_with(b"://")
}

pub fn tab_referrer(referrer: &Referrer, target: &str) -> String {
    let Some(from) = origin_of(&referrer.url) else {
        return String::new();
    };
    if from == "null" || referrer.policy == ReferrerPolicy::NoReferrer {
        return String::new();
    }
    match referrer.policy {
        ReferrerPolicy::SameOrigin => {
            if origin_of(target).as_deref() == Some(from.as_str()) {
                referrer.url.clone()
            } else {
                String::new()
            }
        }
        ReferrerPolicy::Origin | ReferrerPolicy::StrictOrigin => format!("{from}/"),
        _ => referrer.url.clone(),
    }
}

#[derive(Debug, Clone)]
struct Remembered {
    referrer: String,
    at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct GuestTabs {
    referrers: Arc<Mutex<HashMap<String, Remembered>>>,
}

fn tab_key(host_id: u32, url: &str) -> String {
    format!("{host_id} {url}")
}

impl GuestTabs {
    pub fn new() -> Self {
        Self::default()
    }

    fn remember(&self, host_id: u32, url: &str, referrer: String, now: i64) {
        let mut referrers = self.referrers.lock();
        referrers.retain(|_, entry| now - entry.at <= TAB_REFERRER_MS);
        if !referrer.is_empty() {
            referrers.insert(tab_key(host_id, url), Remembered { referrer, at: now });
        }
    }

    pub fn tab_referrer_of(&self, host_id: u32, url: &str, now: i64) -> Option<String> {
        let referrers = self.referrers.lock();
        let entry = referrers.get(&tab_key(host_id, url))?;
        (now - entry.at <= TAB_REFERRER_MS).then(|| entry.referrer.clone())
    }

    pub fn open_guest_tab(
        &self,
        guest: &TabGuest,
        url: &str,
        background: bool,
        referrer: &Referrer,
        now: i64,
    ) {
        let Some(host) = guest.host.as_ref() else {
            return;
        };
        if host.is_destroyed() || !is_tab_url(url) {
            return;
        }
        self.remember(host.id(), url, tab_referrer(referrer, url), now);
        host.send_open_tab(BrowserTabOpen {
            guest_id: guest.id,
            url: url.to_owned(),
            background,
        });
    }
}
