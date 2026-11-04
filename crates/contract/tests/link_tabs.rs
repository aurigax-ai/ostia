#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::link_tabs::is_tab_url;

#[test]
fn opens_an_http_or_https_url_in_a_tab() {
    assert!(is_tab_url("http://x.test"));
    assert!(is_tab_url("https://x.test/a?b=1"));
}

#[test]
fn reads_the_scheme_in_any_case() {
    assert!(is_tab_url("HTTP://x.test"));
    assert!(is_tab_url("HtTpS://x.test"));
}

#[test]
fn refuses_every_other_scheme() {
    for url in [
        "file:///tmp/a.html",
        "ftp://x.test",
        "javascript:alert(1)",
        "data:text/html,hi",
        "about:blank",
        "mailto:a@x.test",
        "blob:https://x.test/1",
        "ws://x.test",
    ] {
        assert!(!is_tab_url(url), "{url}");
    }
}

#[test]
fn refuses_text_that_does_not_start_with_the_scheme() {
    for url in [
        "",
        "x.test",
        "//x.test",
        " https://x.test",
        "\nhttps://x.test",
        "xhttps://x.test",
        "http:/x.test",
        "https:x.test",
        "https//x.test",
    ] {
        assert!(!is_tab_url(url), "{url:?}");
    }
}

#[test]
fn needs_nothing_after_the_slashes() {
    assert!(is_tab_url("https://"));
}
