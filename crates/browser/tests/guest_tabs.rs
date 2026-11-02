#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use ostia_browser::guest_tabs::{
    BrowserTabOpen, GuestTabs, Referrer, ReferrerPolicy, TAB_REFERRER_MS, TabGuest, TabHost,
    tab_referrer,
};

const PAGE: &str = "https://site.example/docs/page?q=1";
const SAME: &str = "https://site.example/other";
const CROSS: &str = "https://docs.example.com/";

fn from(policy: ReferrerPolicy) -> Referrer {
    Referrer {
        url: PAGE.to_owned(),
        policy,
    }
}

fn from_url(policy: ReferrerPolicy, url: &str) -> Referrer {
    Referrer {
        url: url.to_owned(),
        policy,
    }
}

#[test]
fn passes_the_page_address_for_the_default_policies_leaving_the_trim_to_chromium() {
    for policy in [
        ReferrerPolicy::Default,
        ReferrerPolicy::StrictOriginWhenCrossOrigin,
        ReferrerPolicy::NoReferrerWhenDowngrade,
        ReferrerPolicy::UnsafeUrl,
    ] {
        assert_eq!(tab_referrer(&from(policy), CROSS), PAGE, "{policy:?}");
    }
}

#[test]
fn sends_nothing_for_no_referrer_an_empty_or_opaque_referrer_or_a_cross_origin_same_origin_policy()
{
    assert_eq!(tab_referrer(&from(ReferrerPolicy::NoReferrer), SAME), "");
    assert_eq!(
        tab_referrer(&from_url(ReferrerPolicy::Default, ""), CROSS),
        ""
    );
    assert_eq!(
        tab_referrer(&from_url(ReferrerPolicy::Default, "about:blank"), CROSS),
        ""
    );
    assert_eq!(tab_referrer(&from(ReferrerPolicy::SameOrigin), CROSS), "");
    assert_eq!(tab_referrer(&from(ReferrerPolicy::SameOrigin), SAME), PAGE);
}

#[test]
fn sends_only_the_origin_for_the_origin_policies_also_to_the_same_origin() {
    assert_eq!(
        tab_referrer(&from(ReferrerPolicy::Origin), SAME),
        "https://site.example/"
    );
    assert_eq!(
        tab_referrer(&from(ReferrerPolicy::StrictOrigin), CROSS),
        "https://site.example/"
    );
}

#[test]
fn sends_nothing_when_the_page_address_does_not_parse() {
    for policy in [
        ReferrerPolicy::Default,
        ReferrerPolicy::Origin,
        ReferrerPolicy::SameOrigin,
    ] {
        assert_eq!(
            tab_referrer(&from_url(policy, "not a url"), CROSS),
            "",
            "{policy:?}"
        );
    }
}

#[test]
fn sends_nothing_for_same_origin_when_the_target_does_not_parse() {
    assert_eq!(
        tab_referrer(&from(ReferrerPolicy::SameOrigin), "not a url"),
        ""
    );
}

#[test]
fn keeps_the_port_in_the_origin_it_sends() {
    let page = from_url(ReferrerPolicy::Origin, "http://site.example:8080/a/b");
    assert_eq!(tab_referrer(&page, CROSS), "http://site.example:8080/");
}

struct FakeHost {
    id: u32,
    alive: bool,
    sent: Mutex<Vec<BrowserTabOpen>>,
}

impl TabHost for FakeHost {
    fn id(&self) -> u32 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        !self.alive
    }

    fn send_open_tab(&self, open: BrowserTabOpen) {
        self.sent.lock().unwrap().push(open);
    }
}

fn guest(id: u32, alive: bool) -> (TabGuest, Arc<FakeHost>) {
    let host = Arc::new(FakeHost {
        id,
        alive,
        sent: Mutex::new(Vec::new()),
    });
    let guest = TabGuest {
        id: 7,
        host: Some(host.clone()),
    };
    (guest, host)
}

fn open(url: &str) -> BrowserTabOpen {
    BrowserTabOpen {
        guest_id: 7,
        url: url.to_owned(),
        background: true,
    }
}

#[test]
fn asks_the_panes_window_for_a_tab_and_keeps_the_referrer_the_pages_policy_allows_for_its_first_load()
 {
    let tabs = GuestTabs::new();
    let (opener, host) = guest(1, true);
    tabs.open_guest_tab(&opener, CROSS, true, &from(ReferrerPolicy::Default), 1000);
    assert_eq!(*host.sent.lock().unwrap(), vec![open(CROSS)]);
    assert_eq!(
        tabs.tab_referrer_of(1, CROSS, 1000 + TAB_REFERRER_MS)
            .as_deref(),
        Some(PAGE)
    );
    assert_eq!(tabs.tab_referrer_of(1, CROSS, 1001 + TAB_REFERRER_MS), None);
    assert_eq!(tabs.tab_referrer_of(1, SAME, 1000), None);
    assert_eq!(tabs.tab_referrer_of(2, CROSS, 1000), None);
}

#[test]
fn keeps_no_referrer_the_policy_withholds() {
    let tabs = GuestTabs::new();
    let (opener, host) = guest(1, true);
    let mut background = open(CROSS);
    background.background = false;
    tabs.open_guest_tab(
        &opener,
        CROSS,
        false,
        &from(ReferrerPolicy::SameOrigin),
        1000,
    );
    assert_eq!(*host.sent.lock().unwrap(), vec![background]);
    assert_eq!(tabs.tab_referrer_of(1, CROSS, 1000), None);
}

#[test]
fn sends_nothing_for_a_non_web_address_or_without_a_live_window() {
    let tabs = GuestTabs::new();
    let (live, live_host) = guest(1, true);
    tabs.open_guest_tab(
        &live,
        "file:///etc/passwd",
        false,
        &from(ReferrerPolicy::Default),
        1000,
    );
    let (gone, gone_host) = guest(2, false);
    tabs.open_guest_tab(&gone, CROSS, false, &from(ReferrerPolicy::Default), 1000);
    let orphan = TabGuest { id: 7, host: None };
    tabs.open_guest_tab(&orphan, CROSS, false, &from(ReferrerPolicy::Default), 1000);
    assert!(live_host.sent.lock().unwrap().is_empty());
    assert!(gone_host.sent.lock().unwrap().is_empty());
    assert_eq!(tabs.tab_referrer_of(1, "file:///etc/passwd", 1000), None);
    assert_eq!(tabs.tab_referrer_of(2, CROSS, 1000), None);
}

#[test]
fn opens_tabs_for_http_and_https_in_any_letter_case_and_for_nothing_else() {
    let tabs = GuestTabs::new();
    let (opener, host) = guest(1, true);
    let accepted = [
        "http://a.example/",
        "HTTPS://a.example/",
        "Http://a.example/",
    ];
    let refused = [
        "ftp://a.example/",
        "javascript:alert(1)",
        "data:text/html,x",
        "about:blank",
        " https://a.example/",
        "https:/a.example/",
        "",
    ];
    for url in accepted.iter().chain(refused.iter()) {
        tabs.open_guest_tab(&opener, url, false, &from(ReferrerPolicy::Default), 1000);
    }
    let sent: Vec<String> = host
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|o| o.url.clone())
        .collect();
    assert_eq!(sent, accepted);
}

#[test]
fn keeps_a_referrer_for_each_window_and_address_apart() {
    let tabs = GuestTabs::new();
    let (first, _) = guest(1, true);
    let (second, _) = guest(2, true);
    let other = Referrer {
        url: SAME.to_owned(),
        policy: ReferrerPolicy::Default,
    };
    tabs.open_guest_tab(&first, CROSS, false, &from(ReferrerPolicy::Default), 1000);
    tabs.open_guest_tab(&second, CROSS, false, &other, 1000);
    assert_eq!(tabs.tab_referrer_of(1, CROSS, 1000).as_deref(), Some(PAGE));
    assert_eq!(tabs.tab_referrer_of(2, CROSS, 1000).as_deref(), Some(SAME));
}

#[test]
fn replaces_the_remembered_referrer_when_the_same_address_opens_again() {
    let tabs = GuestTabs::new();
    let (opener, _) = guest(1, true);
    let later = Referrer {
        url: SAME.to_owned(),
        policy: ReferrerPolicy::Default,
    };
    tabs.open_guest_tab(&opener, CROSS, false, &from(ReferrerPolicy::Default), 1000);
    tabs.open_guest_tab(&opener, CROSS, false, &later, 2000);
    assert_eq!(tabs.tab_referrer_of(1, CROSS, 2000).as_deref(), Some(SAME));
}

#[test]
fn keeps_the_old_referrer_when_a_later_open_withholds_its_own() {
    let tabs = GuestTabs::new();
    let (opener, _) = guest(1, true);
    tabs.open_guest_tab(&opener, CROSS, false, &from(ReferrerPolicy::Default), 1000);
    tabs.open_guest_tab(
        &opener,
        CROSS,
        false,
        &from(ReferrerPolicy::NoReferrer),
        2000,
    );
    assert_eq!(tabs.tab_referrer_of(1, CROSS, 2000).as_deref(), Some(PAGE));
}

#[test]
fn shares_the_remembered_referrers_between_clones() {
    let tabs = GuestTabs::new();
    let clone = tabs.clone();
    let (opener, _) = guest(1, true);
    tabs.open_guest_tab(&opener, CROSS, false, &from(ReferrerPolicy::Default), 1000);
    assert_eq!(clone.tab_referrer_of(1, CROSS, 1000).as_deref(), Some(PAGE));
}

#[test]
fn holds_a_referrer_for_thirty_seconds() {
    assert_eq!(TAB_REFERRER_MS, 30_000);
}
