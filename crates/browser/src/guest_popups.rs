use std::collections::HashMap;
use std::sync::Arc;

use ostia_contract::link_tabs::is_tab_url;
use parking_lot::Mutex;
use url::Url;

use crate::guest_link_clicks::clicked_link_of;
use crate::guest_tabs::Referrer;

pub const POPUP_GESTURE_MS: i64 = 5000;

pub const LINK_CLICK_MS: i64 = 1000;

const GESTURE_INPUTS: [&str; 3] = ["mouseDown", "keyDown", "touchStart"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClickedLink {
    pub url: String,
    pub at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GuestActivity {
    pub input_at: Option<i64>,
    pub agent_at: Option<i64>,
    pub link: Option<ClickedLink>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Default,
    ForegroundTab,
    BackgroundTab,
    NewWindow,
    SaveToDisk,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowOpenDetails {
    pub url: String,
    pub frame_name: String,
    pub features: String,
    pub disposition: Disposition,
    pub referrer: Referrer,
    pub post_body: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PopupWebPreferences {
    pub preload: Option<String>,
    pub node_integration: bool,
    pub context_isolation: bool,
    pub sandbox: bool,
    pub webview_tag: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PopupWindowOptions {
    pub parent: u32,
    pub auto_hide_menu_bar: bool,
    pub web_preferences: PopupWebPreferences,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowOpenDecision {
    Deny,
    Allow(PopupWindowOptions),
}

pub trait PopupWindow {
    fn id(&self) -> u32;
    fn remove_menu(&self);
    fn set_title(&self, title: &str);
    fn url(&self) -> String;
    fn deny_window_open(&self);
    fn prevent_default_title(&self);
}

pub trait PopupHost: Send + Sync {
    fn is_human_profile(&self, guest_id: u32) -> bool;
    fn owner_window(&self, guest_id: u32) -> Option<u32>;
    fn prepare(&self, popup: &dyn PopupWindow, url: &str);
    fn open_tab(&self, opener: u32, url: &str, background: bool, referrer: &Referrer);
}

pub fn human_gesture_allows_popup(activity: Option<&GuestActivity>, now: i64) -> bool {
    let Some(activity) = activity else {
        return false;
    };
    let Some(input_at) = activity.input_at else {
        return false;
    };
    if now - input_at > POPUP_GESTURE_MS {
        return false;
    }
    activity
        .agent_at
        .is_none_or(|agent_at| now - agent_at > POPUP_GESTURE_MS)
}

pub fn popup_title(url: &str, title: &str) -> String {
    let host = Url::parse(url)
        .ok()
        .and_then(|parsed| {
            let host = parsed.host_str()?;
            Some(match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_owned(),
            })
        })
        .unwrap_or_default();
    if host.is_empty() {
        return title.to_owned();
    }
    if !title.is_empty() && title != host {
        format!("{host} · {title}")
    } else {
        host
    }
}

fn popup_window_options(parent: u32) -> PopupWindowOptions {
    PopupWindowOptions {
        parent,
        auto_hide_menu_bar: true,
        web_preferences: PopupWebPreferences {
            preload: None,
            node_integration: false,
            context_isolation: true,
            sandbox: true,
            webview_tag: false,
        },
    }
}

fn clicked_just_now(activity: &mut GuestActivity, url: &str, now: i64) -> bool {
    let link = activity.link.take();
    link.is_some_and(|link| link.url == url && now - link.at <= LINK_CLICK_MS)
}

fn opens_as_tab(details: &WindowOpenDetails, activity: &mut GuestActivity, now: i64) -> bool {
    if details.post_body || !is_tab_url(&details.url) {
        return false;
    }
    match details.disposition {
        Disposition::BackgroundTab => true,
        Disposition::ForegroundTab => {
            let plain = details.frame_name.is_empty() && details.features.is_empty();
            clicked_just_now(activity, &details.url, now) && plain
        }
        _ => false,
    }
}

#[derive(Clone)]
pub struct GuestPopups {
    host: Arc<dyn PopupHost>,
    activities: Arc<Mutex<HashMap<u32, GuestActivity>>>,
}

impl GuestPopups {
    pub fn new(host: Arc<dyn PopupHost>) -> Self {
        Self {
            host,
            activities: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn note_agent_drive(&self, guest_id: u32, now: i64) {
        self.activities.lock().entry(guest_id).or_default().agent_at = Some(now);
    }

    pub fn input_event(&self, guest_id: u32, kind: &str, now: i64) {
        if GESTURE_INPUTS.contains(&kind) {
            self.activities.lock().entry(guest_id).or_default().input_at = Some(now);
        }
    }

    pub fn console_message(&self, guest_id: u32, message: &str, now: i64) {
        if let Some(url) = clicked_link_of(message) {
            self.activities.lock().entry(guest_id).or_default().link =
                Some(ClickedLink { url, at: now });
        }
    }

    pub fn guest_destroyed(&self, guest_id: u32) {
        self.activities.lock().remove(&guest_id);
    }

    pub fn window_open(
        &self,
        guest_id: u32,
        details: &WindowOpenDetails,
        now: i64,
    ) -> WindowOpenDecision {
        let Some(parent) = self.host.owner_window(guest_id) else {
            return WindowOpenDecision::Deny;
        };
        if !self.host.is_human_profile(guest_id) {
            return WindowOpenDecision::Deny;
        }
        let as_tab = {
            let mut activities = self.activities.lock();
            if !human_gesture_allows_popup(activities.get(&guest_id), now) {
                return WindowOpenDecision::Deny;
            }
            let activity = activities.entry(guest_id).or_default();
            activity.input_at = None;
            opens_as_tab(details, activity, now)
        };
        if as_tab {
            let background = details.disposition == Disposition::BackgroundTab;
            self.host
                .open_tab(guest_id, &details.url, background, &details.referrer);
            return WindowOpenDecision::Deny;
        }
        WindowOpenDecision::Allow(popup_window_options(parent))
    }

    pub fn popup_created(&self, popup: &dyn PopupWindow, opened_url: &str) {
        popup.remove_menu();
        popup.deny_window_open();
        popup.set_title(&popup_title(opened_url, ""));
        self.host.prepare(popup, opened_url);
    }

    pub fn popup_title_updated(&self, popup: &dyn PopupWindow, opened_url: &str, title: &str) {
        popup.prevent_default_title();
        let current = popup.url();
        let url = if current.is_empty() {
            opened_url
        } else {
            &current
        };
        popup.set_title(&popup_title(url, title));
    }
}
