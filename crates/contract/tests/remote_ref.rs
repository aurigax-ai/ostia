#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::remote_ref::{
    back_notice, desktop_ref, is_pane_id, offline_notice, parse_desktop_ref, parse_remote_ref,
    remote_ref, remote_route,
};

fn parsed(text: &str) -> Option<(String, String)> {
    parse_remote_ref(text).map(|found| (found.host, found.pane))
}

#[test]
fn builds_a_remote_ref_a_route_and_a_desktop_ref() {
    assert_eq!(remote_ref("box", "0a1b2c3d"), "remote:box:0a1b2c3d");
    assert_eq!(remote_route("box"), "remote:box");
    assert_eq!(desktop_ref("p1"), "desktop:p1");
}

#[test]
fn reads_a_remote_ref_back_into_host_and_pane() {
    assert_eq!(
        parsed("remote:box:0a1b2c3d"),
        Some(("box".to_owned(), "0a1b2c3d".to_owned()))
    );
    assert_eq!(
        parsed("remote:Dev-1.lan_x:ffffffff"),
        Some(("Dev-1.lan_x".to_owned(), "ffffffff".to_owned()))
    );
}

#[test]
fn refuses_a_remote_ref_with_a_bad_host_or_pane() {
    let refused = [
        "",
        "remote:box",
        "remote::0a1b2c3d",
        "remote:-box:0a1b2c3d",
        "remote:.box:0a1b2c3d",
        "remote:bo x:0a1b2c3d",
        "remote:box:0A1B2C3D",
        "remote:box:0a1b2c3",
        "remote:box:0a1b2c3d4",
        "remote:box:0a1b2c3g",
        "remote:box:0a1b2c3d\n",
        "remote:box\n:0a1b2c3d",
        "xremote:box:0a1b2c3d",
        "remote:box:0a1b2c3d:more",
        "remote:bóx:0a1b2c3d",
    ];
    for text in refused {
        assert_eq!(parsed(text), None, "{text:?}");
    }
}

#[test]
fn limits_a_host_name_to_253_characters() {
    let longest = format!("a{}", "b".repeat(252));
    assert_eq!(
        parsed(&format!("remote:{longest}:0a1b2c3d")),
        Some((longest, "0a1b2c3d".to_owned()))
    );
    let too_long = format!("a{}", "b".repeat(253));
    assert_eq!(parsed(&format!("remote:{too_long}:0a1b2c3d")), None);
}

#[test]
fn reads_a_host_with_colons_only_when_the_last_part_is_a_pane_id() {
    assert_eq!(parsed("remote:a:b:0a1b2c3d"), None);
}

#[test]
fn knows_a_pane_id_only_as_eight_lower_case_hex_digits() {
    let table = [
        ("0a1b2c3d", true),
        ("00000000", true),
        ("ffffffff", true),
        ("", false),
        ("0a1b2c3", false),
        ("0a1b2c3d4", false),
        ("0A1B2C3D", false),
        ("0a1b2c3z", false),
        ("0a1b2c3d\n", false),
        (
            "\u{0663}\u{0663}\u{0663}\u{0663}\u{0663}\u{0663}\u{0663}\u{0663}",
            false,
        ),
    ];
    for (text, expected) in table {
        assert_eq!(is_pane_id(text), expected, "{text:?}");
    }
}

#[test]
fn reads_a_desktop_ref_and_refuses_the_bare_prefix() {
    assert_eq!(parse_desktop_ref("desktop:p1"), Some("p1".to_owned()));
    assert_eq!(parse_desktop_ref("desktop:a:b"), Some("a:b".to_owned()));
    assert_eq!(parse_desktop_ref("desktop:"), None);
    assert_eq!(parse_desktop_ref("Desktop:p1"), None);
    assert_eq!(parse_desktop_ref(" desktop:p1"), None);
    assert_eq!(parse_desktop_ref("p1"), None);
    assert_eq!(parse_desktop_ref(""), None);
}

#[test]
fn writes_the_offline_notice_with_one_message_and_with_many() {
    assert_eq!(
        offline_notice("box", "10:00", 1),
        "box is offline since 10:00; 1 message wait and go when it is back."
    );
    assert_eq!(
        offline_notice("box", "10:00", 0),
        "box is offline since 10:00; 0 messages wait and go when it is back."
    );
    assert_eq!(
        offline_notice("box", "10:00", 2),
        "box is offline since 10:00; 2 messages wait and go when it is back."
    );
}

#[test]
fn writes_the_back_notice_with_one_message_and_with_many() {
    assert_eq!(
        back_notice("box", 1, 0),
        "box is back; 1 message delivered, 0 expired."
    );
    assert_eq!(
        back_notice("box", 0, 1),
        "box is back; 0 messages delivered, 1 expired."
    );
    assert_eq!(
        back_notice("box", 5, 3),
        "box is back; 5 messages delivered, 3 expired."
    );
}
