#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::Cell;
use std::sync::{Arc, Mutex};

use ostia_browser::guest_link_clicks::LINK_CLICK_SCRIPT;
use ostia_browser::guest_popups::{
    Disposition, GuestActivity, GuestPopups, LINK_CLICK_MS, POPUP_GESTURE_MS, PopupHost,
    PopupWebPreferences, PopupWindow, PopupWindowOptions, WindowOpenDecision, WindowOpenDetails,
    human_gesture_allows_popup, popup_title,
};
use ostia_browser::guest_tabs::{Referrer, ReferrerPolicy};

const GUEST: u32 = 100;
const PARENT: u32 = 7;
const START: i64 = 1_000_000;

fn referrer() -> Referrer {
    Referrer {
        url: "https://site.example/".to_owned(),
        policy: ReferrerPolicy::StrictOriginWhenCrossOrigin,
    }
}

fn popup() -> WindowOpenDetails {
    WindowOpenDetails {
        url: "https://accounts.example.com/authorize".to_owned(),
        frame_name: "signin".to_owned(),
        features: "popup,width=420,height=520".to_owned(),
        disposition: Disposition::NewWindow,
        referrer: referrer(),
        post_body: false,
    }
}

fn link(disposition: Disposition, url: &str) -> WindowOpenDetails {
    WindowOpenDetails {
        url: url.to_owned(),
        frame_name: String::new(),
        features: String::new(),
        disposition,
        ..popup()
    }
}

fn docs(disposition: Disposition) -> WindowOpenDetails {
    link(disposition, "https://docs.example.com/")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenedTab {
    opener: u32,
    url: String,
    background: bool,
    referrer: Referrer,
}

struct FakeHost {
    human: bool,
    owned: bool,
    tabs: Mutex<Vec<OpenedTab>>,
    prepared: Mutex<Vec<(u32, String)>>,
}

impl PopupHost for FakeHost {
    fn is_human_profile(&self, _guest_id: u32) -> bool {
        self.human
    }

    fn owner_window(&self, _guest_id: u32) -> Option<u32> {
        self.owned.then_some(PARENT)
    }

    fn open_tab(&self, opener: u32, url: &str, background: bool, referrer: &Referrer) {
        self.tabs.lock().unwrap().push(OpenedTab {
            opener,
            url: url.to_owned(),
            background,
            referrer: referrer.clone(),
        });
    }

    fn prepare(&self, popup: &dyn PopupWindow, url: &str) {
        self.prepared
            .lock()
            .unwrap()
            .push((popup.id(), url.to_owned()));
    }
}

struct Setup {
    popups: GuestPopups,
    host: Arc<FakeHost>,
    at: Cell<i64>,
}

fn setup(human: bool, owned: bool) -> Setup {
    let host = Arc::new(FakeHost {
        human,
        owned,
        tabs: Mutex::new(Vec::new()),
        prepared: Mutex::new(Vec::new()),
    });
    Setup {
        popups: GuestPopups::new(host.clone()),
        host,
        at: Cell::new(START),
    }
}

fn setup_default() -> Setup {
    setup(true, true)
}

impl Setup {
    fn input(&self, kind: &str) {
        self.popups.input_event(GUEST, kind, self.at.get());
    }

    fn console(&self, href: &str) {
        let source = &LINK_CLICK_SCRIPT.source;
        let start = source.find("console.debug(\"").unwrap() + "console.debug(\"".len();
        let marker = &source[start..start + source[start..].find('"').unwrap()];
        self.popups
            .console_message(GUEST, &format!("{marker}{href}"), self.at.get());
    }

    fn click(&self, href: &str) {
        self.input("mouseDown");
        self.console(href);
    }

    fn click_docs(&self) {
        self.click("https://docs.example.com/");
    }

    fn agent(&self) {
        self.popups.note_agent_drive(GUEST, self.at.get());
    }

    fn pass(&self, ms: i64) {
        self.at.set(self.at.get() + ms);
    }

    fn open(&self, details: &WindowOpenDetails) -> WindowOpenDecision {
        self.popups.window_open(GUEST, details, self.at.get())
    }

    fn allowed(&self, details: &WindowOpenDetails) -> bool {
        matches!(self.open(details), WindowOpenDecision::Allow(_))
    }

    fn tabs(&self) -> Vec<OpenedTab> {
        self.host.tabs.lock().unwrap().clone()
    }
}

struct FakePopup {
    id: u32,
    current_url: String,
    removed_menu: Mutex<bool>,
    titles: Mutex<Vec<String>>,
    nested_denied: Mutex<bool>,
    default_prevented: Mutex<bool>,
}

impl PopupWindow for FakePopup {
    fn id(&self) -> u32 {
        self.id
    }

    fn remove_menu(&self) {
        *self.removed_menu.lock().unwrap() = true;
    }

    fn set_title(&self, title: &str) {
        self.titles.lock().unwrap().push(title.to_owned());
    }

    fn url(&self) -> String {
        self.current_url.clone()
    }

    fn deny_window_open(&self) {
        *self.nested_denied.lock().unwrap() = true;
    }

    fn prevent_default_title(&self) {
        *self.default_prevented.lock().unwrap() = true;
    }
}

#[test]
fn needs_an_input_no_older_than_the_gesture_window() {
    assert!(!human_gesture_allows_popup(None, 10));
    assert!(!human_gesture_allows_popup(
        Some(&GuestActivity::default()),
        10
    ));
    let at_zero = GuestActivity {
        input_at: Some(0),
        ..GuestActivity::default()
    };
    assert!(human_gesture_allows_popup(Some(&at_zero), POPUP_GESTURE_MS));
    assert!(!human_gesture_allows_popup(
        Some(&at_zero),
        POPUP_GESTURE_MS + 1
    ));
}

#[test]
fn refuses_while_an_agent_drove_the_guest_inside_the_window() {
    let before = GuestActivity {
        input_at: Some(100),
        agent_at: Some(90),
        ..GuestActivity::default()
    };
    assert!(!human_gesture_allows_popup(Some(&before), 200));
    let after = GuestActivity {
        input_at: Some(100),
        agent_at: Some(150),
        ..GuestActivity::default()
    };
    assert!(!human_gesture_allows_popup(Some(&after), 200));
    let later = POPUP_GESTURE_MS + 200;
    let old_drive = GuestActivity {
        input_at: Some(later - 10),
        agent_at: Some(100),
        ..GuestActivity::default()
    };
    assert!(human_gesture_allows_popup(Some(&old_drive), later));
}

#[test]
fn opens_a_child_window_of_the_owner_without_a_preload_right_after_the_humans_click() {
    let guest = setup_default();
    guest.input("mouseDown");
    assert_eq!(
        guest.open(&popup()),
        WindowOpenDecision::Allow(PopupWindowOptions {
            parent: PARENT,
            auto_hide_menu_bar: true,
            web_preferences: PopupWebPreferences {
                preload: None,
                node_integration: false,
                context_isolation: true,
                sandbox: true,
                webview_tag: false,
            },
        })
    );
}

#[test]
fn opens_one_window_per_gesture() {
    let guest = setup_default();
    guest.input("keyDown");
    assert!(guest.allowed(&popup()));
    assert_eq!(guest.open(&popup()), WindowOpenDecision::Deny);
}

#[test]
fn opens_nothing_without_an_input_for_a_pointer_move_or_after_the_window_passed() {
    let guest = setup_default();
    assert_eq!(guest.open(&popup()), WindowOpenDecision::Deny);
    guest.input("mouseMove");
    assert_eq!(guest.open(&popup()), WindowOpenDecision::Deny);
    guest.input("mouseDown");
    guest.pass(POPUP_GESTURE_MS + 1);
    assert_eq!(guest.open(&popup()), WindowOpenDecision::Deny);
}

#[test]
fn opens_nothing_for_a_pane_outside_the_humans_profile_or_without_an_app_window() {
    let agent_pane = setup(false, true);
    agent_pane.input("mouseDown");
    assert_eq!(agent_pane.open(&popup()), WindowOpenDecision::Deny);
    let orphan = setup(true, false);
    orphan.input("mouseDown");
    assert_eq!(orphan.open(&popup()), WindowOpenDecision::Deny);
}

#[test]
fn opens_nothing_for_input_an_agent_sent_into_the_humans_pane() {
    let guest = setup_default();
    guest.agent();
    guest.input("mouseDown");
    assert_eq!(guest.open(&popup()), WindowOpenDecision::Deny);
    guest.pass(POPUP_GESTURE_MS - 1);
    guest.input("mouseDown");
    assert_eq!(guest.open(&popup()), WindowOpenDecision::Deny);
    guest.pass(2);
    guest.input("mouseDown");
    assert!(guest.allowed(&popup()));
}

#[test]
fn opens_the_link_the_human_clicked_as_a_shown_tab_and_a_modified_click_as_a_background_tab() {
    let guest = setup_default();
    guest.click_docs();
    assert_eq!(
        guest.open(&docs(Disposition::ForegroundTab)),
        WindowOpenDecision::Deny
    );
    assert_eq!(
        guest.tabs().last().unwrap(),
        &OpenedTab {
            opener: GUEST,
            url: "https://docs.example.com/".to_owned(),
            background: false,
            referrer: referrer(),
        }
    );
    guest.input("mouseDown");
    assert_eq!(
        guest.open(&link(Disposition::BackgroundTab, "http://127.0.0.1:8080/a")),
        WindowOpenDecision::Deny
    );
    assert_eq!(
        guest.tabs().last().unwrap(),
        &OpenedTab {
            opener: GUEST,
            url: "http://127.0.0.1:8080/a".to_owned(),
            background: true,
            referrer: referrer(),
        }
    );
    assert_eq!(
        guest.open(&docs(Disposition::ForegroundTab)),
        WindowOpenDecision::Deny
    );
    assert_eq!(guest.tabs().len(), 2);
}

#[test]
fn keeps_window_open_without_features_a_popup_with_its_opener_when_no_link_was_clicked() {
    let guest = setup_default();
    guest.input("mouseDown");
    match guest.open(&docs(Disposition::ForegroundTab)) {
        WindowOpenDecision::Allow(options) => assert_eq!(options.parent, PARENT),
        WindowOpenDecision::Deny => panic!("expected a popup"),
    }
    assert!(guest.tabs().is_empty());
}

#[test]
fn keeps_a_popup_for_another_address_a_stale_click_a_named_window_features_a_non_web_address_or_a_form_post()
 {
    let guest = setup_default();
    let cases: Vec<(Option<&str>, WindowOpenDetails)> = vec![
        (
            Some("https://docs.example.com/other"),
            docs(Disposition::ForegroundTab),
        ),
        (None, docs(Disposition::ForegroundTab)),
        (
            Some("https://docs.example.com/"),
            WindowOpenDetails {
                frame_name: "docs".to_owned(),
                ..docs(Disposition::ForegroundTab)
            },
        ),
        (
            Some("https://docs.example.com/"),
            WindowOpenDetails {
                features: "noopener".to_owned(),
                ..docs(Disposition::ForegroundTab)
            },
        ),
        (Some("https://docs.example.com/"), popup()),
        (
            Some("about:blank"),
            link(Disposition::ForegroundTab, "about:blank"),
        ),
        (
            Some("https://docs.example.com/"),
            WindowOpenDetails {
                post_body: true,
                ..docs(Disposition::ForegroundTab)
            },
        ),
    ];
    for (index, (href, details)) in cases.iter().enumerate() {
        match href {
            None => {
                guest.click_docs();
                guest.pass(LINK_CLICK_MS + 1);
            }
            Some(href) => guest.click(href),
        }
        assert!(guest.allowed(details), "case {index}");
    }
    assert!(guest.tabs().is_empty());
}

#[test]
fn uses_a_clicked_link_once() {
    let guest = setup_default();
    guest.click_docs();
    assert_eq!(
        guest.open(&docs(Disposition::ForegroundTab)),
        WindowOpenDecision::Deny
    );
    guest.input("mouseDown");
    assert!(guest.allowed(&docs(Disposition::ForegroundTab)));
    assert_eq!(guest.tabs().len(), 1);
}

#[test]
fn opens_no_tab_without_the_humans_input_from_an_agent_pane_or_for_an_agents_input() {
    let quiet = setup_default();
    quiet.console("https://docs.example.com/");
    assert_eq!(
        quiet.open(&docs(Disposition::ForegroundTab)),
        WindowOpenDecision::Deny
    );
    quiet.click_docs();
    quiet.pass(POPUP_GESTURE_MS + 1);
    assert_eq!(
        quiet.open(&docs(Disposition::BackgroundTab)),
        WindowOpenDecision::Deny
    );
    assert!(quiet.tabs().is_empty());

    let agent_pane = setup(false, true);
    agent_pane.click_docs();
    assert_eq!(
        agent_pane.open(&docs(Disposition::ForegroundTab)),
        WindowOpenDecision::Deny
    );
    assert_eq!(
        agent_pane.open(&docs(Disposition::BackgroundTab)),
        WindowOpenDecision::Deny
    );
    assert!(agent_pane.tabs().is_empty());

    let driven = setup_default();
    driven.agent();
    driven.click_docs();
    assert_eq!(
        driven.open(&docs(Disposition::ForegroundTab)),
        WindowOpenDecision::Deny
    );
    assert_eq!(
        driven.open(&docs(Disposition::BackgroundTab)),
        WindowOpenDecision::Deny
    );
    assert!(driven.tabs().is_empty());
}

#[test]
fn forgets_a_destroyed_guest() {
    let guest = setup_default();
    guest.input("mouseDown");
    guest.popups.guest_destroyed(GUEST);
    assert_eq!(guest.open(&popup()), WindowOpenDecision::Deny);
}

#[test]
fn shows_the_host_in_the_popup_title_denies_nested_popups_and_hands_the_window_on() {
    let guest = setup_default();
    let window = FakePopup {
        id: 55,
        current_url: "https://accounts.example.com/next".to_owned(),
        removed_menu: Mutex::new(false),
        titles: Mutex::new(Vec::new()),
        nested_denied: Mutex::new(false),
        default_prevented: Mutex::new(false),
    };
    let opened = "https://accounts.example.com/authorize";
    guest.popups.popup_created(&window, opened);
    assert!(*window.removed_menu.lock().unwrap());
    assert_eq!(
        window.titles.lock().unwrap().last().unwrap(),
        "accounts.example.com"
    );
    assert!(*window.nested_denied.lock().unwrap());
    guest
        .popups
        .popup_title_updated(&window, opened, "Your bank");
    assert!(*window.default_prevented.lock().unwrap());
    assert_eq!(
        window.titles.lock().unwrap().last().unwrap(),
        "accounts.example.com · Your bank"
    );
    assert_eq!(
        guest.host.prepared.lock().unwrap().as_slice(),
        &[(55, opened.to_owned())]
    );
}

#[test]
fn leads_with_the_host_and_falls_back_to_the_title_alone() {
    assert_eq!(
        popup_title("http://127.0.0.1:8080/a", "Sign in"),
        "127.0.0.1:8080 · Sign in"
    );
    assert_eq!(
        popup_title("https://id.example.com/", "id.example.com"),
        "id.example.com"
    );
    assert_eq!(popup_title("about:blank", "Loading"), "Loading");
    assert_eq!(popup_title("not a url", ""), "");
}
