#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::credentials::{CREDENTIAL_FIELD_MAX, normalize_origin};

#[test]
fn keeps_only_the_scheme_host_and_port_of_an_http_s_url() {
    assert_eq!(
        normalize_origin("https://github.com/login?x=1").as_deref(),
        Some("https://github.com")
    );
    assert_eq!(
        normalize_origin("http://localhost:3000/a").as_deref(),
        Some("http://localhost:3000")
    );
}

#[test]
fn refuses_other_schemes_and_junk() {
    assert_eq!(normalize_origin("file:///etc/passwd"), None);
    assert_eq!(normalize_origin("javascript:alert(1)"), None);
    assert_eq!(normalize_origin("github.com"), None);
}

#[test]
fn refuses_every_scheme_that_is_not_http_or_https() {
    for raw in [
        "ftp://x.test",
        "ws://x.test",
        "wss://x.test",
        "data:text/html,hi",
        "blob:https://x.test/1",
        "view-source:https://x.test",
        "about:blank",
        "mailto:a@x.test",
    ] {
        assert_eq!(normalize_origin(raw), None, "{raw}");
    }
}

#[test]
fn refuses_empty_text_and_a_url_without_a_host() {
    for raw in ["", "   ", "https://", "http://", "https://:8080"] {
        assert_eq!(normalize_origin(raw), None, "{raw:?}");
    }
}

#[test]
fn trims_the_text_with_the_js_space_set_before_it_reads_the_url() {
    assert_eq!(
        normalize_origin("  https://github.com/x \n").as_deref(),
        Some("https://github.com")
    );
    assert_eq!(
        normalize_origin("\u{feff}https://github.com").as_deref(),
        Some("https://github.com")
    );
}

#[test]
fn lowercases_the_scheme_and_host_and_drops_a_default_port() {
    let table = [
        ("HTTPS://GitHub.COM/x", "https://github.com"),
        ("https://github.com:443/x", "https://github.com"),
        ("http://x.test:80", "http://x.test"),
        ("https://x.test:80", "https://x.test:80"),
        ("http://x.test:8080/a", "http://x.test:8080"),
    ];
    for (raw, expected) in table {
        assert_eq!(normalize_origin(raw).as_deref(), Some(expected), "{raw}");
    }
}

#[test]
fn drops_user_info_query_and_fragment() {
    assert_eq!(
        normalize_origin("https://user:pw@x.test/a?b=1#c").as_deref(),
        Some("https://x.test")
    );
}

#[test]
fn writes_an_international_host_in_ascii() {
    assert_eq!(
        normalize_origin("https://exämple.test/").as_deref(),
        Some("https://xn--exmple-cua.test")
    );
}

#[test]
fn writes_an_ipv6_host_with_brackets() {
    assert_eq!(
        normalize_origin("http://[::1]:3000/a").as_deref(),
        Some("http://[::1]:3000")
    );
}

#[test]
fn limits_a_username_and_a_password_to_1024_units() {
    assert_eq!(CREDENTIAL_FIELD_MAX, 1024);
}
