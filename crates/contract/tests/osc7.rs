#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::osc7::{CwdReport, is_host_named, parse_osc7};

fn report(host: &str, path: &str) -> Option<CwdReport> {
    Some(CwdReport {
        host: host.to_owned(),
        path: path.to_owned(),
    })
}

#[test]
fn reads_the_host_and_the_path_of_a_file_url() {
    assert_eq!(
        parse_osc7("file://box.local/home/me/src"),
        report("box.local", "/home/me/src")
    );
}

#[test]
fn reads_an_empty_host() {
    assert_eq!(parse_osc7("file:///tmp/x"), report("", "/tmp/x"));
}

#[test]
fn splits_at_the_first_slash_after_the_scheme() {
    assert_eq!(parse_osc7("file://h//a//b"), report("h", "//a//b"));
    assert_eq!(parse_osc7("file://h/"), report("h", "/"));
}

#[test]
fn does_not_decode_percent_escapes() {
    assert_eq!(
        parse_osc7("file://h/a%20b/%E6%97%A5"),
        report("h", "/a%20b/%E6%97%A5")
    );
}

#[test]
fn refuses_text_that_is_not_a_file_url_with_a_path() {
    let rows = [
        "",
        "file://",
        "file://host",
        "file:/tmp/x",
        "http://h/x",
        "FILE://h/x",
        " file://h/x",
        "x file://h/x",
    ];
    for data in rows {
        assert_eq!(parse_osc7(data), None, "data {data:?}");
    }
}

#[test]
fn refuses_a_path_that_holds_a_js_line_terminator_because_dot_stops_there() {
    let rows = [
        "file://h/a\nb",
        "file://h/a\rb",
        "file://h/a\u{2028}b",
        "file://h/a\u{2029}b",
        "file://h/a\n",
    ];
    for data in rows {
        assert_eq!(parse_osc7(data), None, "data {data:?}");
    }
}

#[test]
fn keeps_the_other_control_characters_and_multibyte_text_in_the_path() {
    assert_eq!(
        parse_osc7("file://h/a\u{85}b\tc/日本語 😀"),
        report("h", "/a\u{85}b\tc/日本語 😀")
    );
}

#[test]
fn takes_a_host_that_holds_a_line_break() {
    assert_eq!(parse_osc7("file://a\nb/x"), report("a\nb", "/x"));
}

#[test]
fn counts_an_empty_or_localhost_host_as_this_machine_in_any_case() {
    for host in ["", "localhost", "LOCALHOST", "LocalHost"] {
        assert!(
            is_host_named(host, Some("box.example.com")),
            "host {host:?}"
        );
    }
}

#[test]
fn counts_every_host_as_local_when_the_local_name_is_unknown() {
    assert!(is_host_named("other.example.com", None));
    assert!(is_host_named("anything", None));
}

#[test]
fn matches_the_full_local_name_or_its_first_label_ignoring_case() {
    let local = Some("Box.Example.com");
    for host in ["box.example.com", "BOX.EXAMPLE.COM", "box", "BOX", "Box"] {
        assert!(is_host_named(host, local), "host {host:?}");
    }
}

#[test]
fn refuses_a_host_that_is_not_the_local_name_or_its_first_label() {
    let local = Some("box.example.com");
    for host in [
        "other",
        "box.example.org",
        "example.com",
        "box.example",
        "x.box",
    ] {
        assert!(!is_host_named(host, local), "host {host:?}");
    }
}

#[test]
fn takes_the_whole_local_name_as_the_first_label_when_it_has_no_dot() {
    assert!(is_host_named("box", Some("box")));
    assert!(is_host_named("BOX", Some("box")));
    assert!(!is_host_named("box.example.com", Some("box")));
}

#[test]
fn lowercases_by_unicode_rules_in_both_names() {
    assert!(is_host_named("ÄBC", Some("äbc.example.com")));
}
