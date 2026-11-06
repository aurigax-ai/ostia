#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use ostia_base::host::{Host, Platform};
use ostia_gateway::server_url::{
    default_server_url, github_device_uri, host_of, parse_server_url, socket_origin,
};

fn host(env: &[(&str, &str)]) -> Host {
    Host {
        env: env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        home: PathBuf::from("/home/test"),
        cwd: PathBuf::from("/home/test"),
        platform: Platform::Linux,
    }
}

#[test]
fn sva_c8_takes_a_bare_host_as_https_and_keeps_only_the_origin() {
    assert_eq!(
        parse_server_url("ostia.example.com", false).as_deref(),
        Some("https://ostia.example.com")
    );
    assert_eq!(
        parse_server_url("  https://ostia.example.com:8443/ ", false).as_deref(),
        Some("https://ostia.example.com:8443")
    );
}

#[test]
fn sva_c9_allows_http_only_for_this_computer_or_when_unpackaged() {
    assert_eq!(parse_server_url("http://example.com", false), None);
    assert_eq!(
        parse_server_url("http://localhost:8080", false).as_deref(),
        Some("http://localhost:8080")
    );
    assert_eq!(
        parse_server_url("http://127.0.0.1:9", false).as_deref(),
        Some("http://127.0.0.1:9")
    );
    assert_eq!(
        parse_server_url("http://[::1]:9", false).as_deref(),
        Some("http://[::1]:9")
    );
    assert_eq!(
        parse_server_url("http://example.com", true).as_deref(),
        Some("http://example.com")
    );
}

#[test]
fn sva_c10_refuses_paths_credentials_queries_other_schemes_and_nonsense() {
    for text in [
        "",
        "   ",
        "https://example.com/v1",
        "https://user:pw@example.com",
        "https://example.com/?a=1",
        "https://example.com/#x",
        "ftp://example.com",
        "ws://example.com",
        "https://",
    ] {
        assert_eq!(parse_server_url(text, true), None, "{text}");
    }
}

#[test]
fn sva_c11_maps_the_origin_to_its_socket_scheme_and_host() {
    assert_eq!(socket_origin("https://a.example"), "wss://a.example");
    assert_eq!(socket_origin("http://127.0.0.1:5"), "ws://127.0.0.1:5");
    assert_eq!(
        host_of("https://a.example:8443").as_deref(),
        Some("a.example:8443")
    );
}

#[test]
fn sva_c56_is_nothing_unless_the_build_stamp_or_unpackaged_the_environment_names_one() {
    assert_eq!(default_server_url(true, &host(&[]), None), None);
    assert_eq!(default_server_url(false, &host(&[]), None), None);
    assert_eq!(
        default_server_url(true, &host(&[]), Some("ostia.example.com")).as_deref(),
        Some("https://ostia.example.com")
    );
}

#[test]
fn sva_c57_takes_ostia_server_url_only_when_unpackaged_and_over_the_stamp() {
    let env = host(&[("OSTIA_SERVER_URL", "http://example.test:8080")]);
    assert_eq!(
        default_server_url(false, &env, Some("ostia.example.com")).as_deref(),
        Some("http://example.test:8080")
    );
    assert_eq!(default_server_url(true, &env, None), None);
    assert_eq!(
        default_server_url(true, &env, Some("ostia.example.com")).as_deref(),
        Some("https://ostia.example.com")
    );
}

#[test]
fn sva_c58_refuses_a_stamp_that_is_not_a_valid_address() {
    assert_eq!(
        default_server_url(true, &host(&[]), Some("http://example.com")),
        None
    );
    assert_eq!(
        default_server_url(true, &host(&[]), Some("https://example.com/path")),
        None
    );
}

#[test]
fn shr_c90_opens_only_https_github_com_login_device() {
    assert_eq!(
        github_device_uri("https://github.com/login/device").as_deref(),
        Some("https://github.com/login/device")
    );
    for bad in [
        "http://github.com/login/device",
        "https://github.com.evil.test/login/device",
        "https://evil.test/login/device",
        "https://github.com:8443/login/device",
        "https://user@github.com/login/device",
        "https://github.com/login/oauth",
        "https://gist.github.com/login/device",
        "file:///etc/passwd",
        "not a url",
    ] {
        assert_eq!(github_device_uri(bad), None, "{bad}");
    }
}

#[test]
fn parses_an_address_with_the_same_edge_cases_as_the_url_parser_of_ts() {
    let table = [
        (
            "HTTPS://Ostia.Example.com",
            Some("https://ostia.example.com"),
        ),
        ("https://example.com:443", Some("https://example.com")),
        ("example.com:8080", Some("https://example.com:8080")),
        ("localhost:3000", Some("https://localhost:3000")),
        (
            "\u{feff}ostia.example.com\u{feff}",
            Some("https://ostia.example.com"),
        ),
        ("https://example.com/", Some("https://example.com")),
        ("https://example.com//", None),
        ("https://user@example.com", None),
        ("https://:pw@example.com", None),
        ("https://example.com?", Some("https://example.com")),
        ("https://example.com#", Some("https://example.com")),
    ];
    for (text, expected) in table {
        assert_eq!(parse_server_url(text, false).as_deref(), expected, "{text}");
    }
}

#[test]
fn uses_the_environment_only_when_it_is_not_empty_and_the_stamp_only_when_it_is_not_empty() {
    let empty = host(&[("OSTIA_SERVER_URL", "")]);
    assert_eq!(
        default_server_url(false, &empty, Some("ostia.example.com")).as_deref(),
        Some("https://ostia.example.com")
    );
    assert_eq!(default_server_url(false, &empty, Some("")), None);
    assert_eq!(default_server_url(true, &host(&[]), Some("")), None);
}

#[test]
fn allows_an_insecure_stamp_only_when_unpackaged() {
    assert_eq!(
        default_server_url(false, &host(&[]), Some("http://example.com")).as_deref(),
        Some("http://example.com")
    );
    assert_eq!(
        default_server_url(true, &host(&[]), Some("http://localhost:1")).as_deref(),
        Some("http://localhost:1")
    );
}

#[test]
fn refuses_an_invalid_environment_address_without_falling_back_to_the_stamp() {
    let env = host(&[("OSTIA_SERVER_URL", "https://example.com/path")]);
    assert_eq!(
        default_server_url(false, &env, Some("ostia.example.com")),
        None
    );
}

#[test]
fn keeps_the_href_of_a_device_link_that_has_a_query_or_the_default_port() {
    assert_eq!(
        github_device_uri("https://github.com/login/device?user_code=ABCD").as_deref(),
        Some("https://github.com/login/device?user_code=ABCD")
    );
    assert_eq!(
        github_device_uri("https://GITHUB.com/login/device").as_deref(),
        Some("https://github.com/login/device")
    );
    assert_eq!(
        github_device_uri("https://github.com:443/login/device").as_deref(),
        Some("https://github.com/login/device")
    );
    assert_eq!(github_device_uri("https://github.com/login/device/"), None);
}
