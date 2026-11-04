#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::browse_input::{
    DEFAULT_SCROLL_PX, KeyCombo, KeyModifier, ScrollDelta, ScrollDirection, glob_matches,
    is_scroll_direction, normalize_url, parse_key_combo, scroll_delta, status_matches,
};
use serde_json::json;

fn combo(text: &str) -> KeyCombo {
    parse_key_combo(text).unwrap()
}

#[test]
fn maps_named_keys_to_electron_key_codes() {
    assert_eq!(
        combo("Enter"),
        KeyCombo {
            key_code: "Return".to_owned(),
            modifiers: vec![],
            printable: false
        }
    );
    assert_eq!(combo("ArrowDown").key_code, "Down");
    assert_eq!(combo("Escape").key_code, "Escape");
}

#[test]
fn splits_modifiers_off_a_combo_like_control_a() {
    assert_eq!(
        combo("Control+a"),
        KeyCombo {
            key_code: "a".to_owned(),
            modifiers: vec![KeyModifier::Control],
            printable: false
        }
    );
    assert_eq!(
        combo("Ctrl+Shift+K").modifiers,
        vec![KeyModifier::Control, KeyModifier::Shift]
    );
    assert_eq!(combo("Meta+Enter").modifiers, vec![KeyModifier::Meta]);
}

#[test]
fn marks_a_plain_or_shifted_character_as_printable() {
    assert!(combo("a").printable);
    assert!(combo("Shift+A").printable);
}

#[test]
fn reads_the_plus_key_itself() {
    assert_eq!(combo("+").key_code, "+");
    assert_eq!(
        combo("Control++"),
        KeyCombo {
            key_code: "+".to_owned(),
            modifiers: vec![KeyModifier::Control],
            printable: false
        }
    );
}

#[test]
fn rejects_unknown_modifiers_and_empty_keys() {
    assert_eq!(parse_key_combo("Hyper+a"), None);
    assert_eq!(parse_key_combo(""), None);
    assert_eq!(parse_key_combo("Control+"), None);
}

#[test]
fn reads_every_modifier_name_in_any_case() {
    let table = [
        ("shift", KeyModifier::Shift),
        ("SHIFT", KeyModifier::Shift),
        ("control", KeyModifier::Control),
        ("ctrl", KeyModifier::Control),
        ("Ctrl", KeyModifier::Control),
        ("alt", KeyModifier::Alt),
        ("option", KeyModifier::Alt),
        ("Option", KeyModifier::Alt),
        ("meta", KeyModifier::Meta),
        ("cmd", KeyModifier::Meta),
        ("command", KeyModifier::Meta),
        ("super", KeyModifier::Meta),
        ("SUPER", KeyModifier::Meta),
    ];
    for (name, modifier) in table {
        assert_eq!(
            combo(&format!("{name}+x")).modifiers,
            vec![modifier],
            "{name}"
        );
    }
}

#[test]
fn lists_a_repeated_modifier_once_in_first_seen_order() {
    assert_eq!(
        combo("ctrl+Shift+Control+a").modifiers,
        vec![KeyModifier::Control, KeyModifier::Shift]
    );
}

#[test]
fn maps_every_key_alias_in_any_case() {
    let table = [
        ("enter", "Return"),
        ("RETURN", "Return"),
        ("esc", "Escape"),
        ("ESCAPE", "Escape"),
        ("arrowup", "Up"),
        ("ArrowDown", "Down"),
        ("ArrowLeft", "Left"),
        ("ArrowRight", "Right"),
        ("up", "Up"),
        ("Down", "Down"),
        ("LEFT", "Left"),
        ("right", "Right"),
        ("space", "Space"),
        (" ", "Space"),
        ("tab", "Tab"),
        ("Backspace", "Backspace"),
        ("DELETE", "Delete"),
        ("home", "Home"),
        ("End", "End"),
        ("pageup", "PageUp"),
        ("PageDown", "PageDown"),
    ];
    for (name, key_code) in table {
        assert_eq!(combo(name).key_code, key_code, "{name}");
    }
}

#[test]
fn keeps_the_case_of_a_key_that_has_no_alias() {
    assert_eq!(combo("A").key_code, "A");
    assert_eq!(combo("F5").key_code, "F5");
    assert_eq!(combo("Shift+Tab").key_code, "Tab");
}

#[test]
fn counts_printable_by_code_point_and_refuses_control_and_meta() {
    assert!(!combo("F5").printable);
    assert!(!combo("Enter").printable);
    assert!(combo("Alt+a").printable);
    assert!(combo("\u{1F600}").printable);
    assert!(!combo("Meta+a").printable);
    assert!(!combo("Ctrl+Alt+a").printable);
}

#[test]
fn rejects_a_trailing_or_doubled_separator() {
    assert_eq!(parse_key_combo("a+"), None);
    assert_eq!(parse_key_combo("+++"), None);
    assert_eq!(parse_key_combo("Control+Shift+"), None);
}

#[test]
fn matches_double_star_and_star_across_path_segments() {
    assert!(glob_matches(
        "**/dashboard",
        "http://localhost:3000/app/dashboard"
    ));
    assert!(glob_matches("*", "https://example.com/a/b?c=1"));
    assert!(glob_matches("*/api/*", "https://x.test/api/users"));
}

#[test]
fn anchors_the_pattern_and_escapes_regex_characters() {
    assert!(!glob_matches(
        "**/dashboard",
        "http://localhost/dashboard/settings"
    ));
    assert!(!glob_matches("https://x.test/a.b", "https://x.test/aXb"));
    assert!(glob_matches("https://x.test/?", "https://x.test/1"));
}

#[test]
fn escapes_every_regex_metacharacter_in_a_pattern() {
    let table = [
        ("a+b", "a+b", true),
        ("a+b", "aab", false),
        ("a^b", "a^b", true),
        ("a$b", "a$b", true),
        ("a{2}", "a{2}", true),
        ("a{2}", "aa", false),
        ("(a)", "(a)", true),
        ("(a)", "a", false),
        ("a|b", "a|b", true),
        ("a|b", "a", false),
        ("[ab]", "[ab]", true),
        ("[ab]", "a", false),
        ("a\\b", "a\\b", true),
        ("a/b", "a/b", true),
    ];
    for (pattern, url, expected) in table {
        assert_eq!(glob_matches(pattern, url), expected, "{pattern} on {url}");
    }
}

#[test]
fn needs_one_character_for_a_question_mark_and_any_run_for_a_star() {
    assert!(!glob_matches("https://x.test/?", "https://x.test/"));
    assert!(!glob_matches("https://x.test/?", "https://x.test/12"));
    assert!(glob_matches("a*b", "ab"));
    assert!(glob_matches("a*b", "aXYZb"));
    assert!(glob_matches("a***b", "aXYZb"));
}

#[test]
fn stops_star_and_question_mark_at_a_line_break_as_a_js_dot_does() {
    assert!(!glob_matches("*", "a\nb"));
    assert!(!glob_matches("a*b", "a\rb"));
    assert!(!glob_matches("a*b", "a\u{2028}b"));
    assert!(!glob_matches("a*b", "a\u{2029}b"));
    assert!(!glob_matches("a?b", "a\nb"));
}

#[test]
fn does_not_match_a_url_with_a_trailing_line_break() {
    assert!(!glob_matches("https://x.test", "https://x.test\n"));
}

#[test]
fn counts_an_astral_character_as_two_for_a_question_mark() {
    assert!(!glob_matches("a?b", "a\u{1F600}b"));
    assert!(glob_matches("a??b", "a\u{1F600}b"));
    assert!(glob_matches("a*b", "a\u{1F600}b"));
}

#[test]
fn turns_a_direction_and_distance_into_a_signed_delta() {
    assert_eq!(
        scroll_delta(ScrollDirection::Down, 300.0),
        ScrollDelta { dx: 0.0, dy: 300.0 }
    );
    assert_eq!(
        scroll_delta(ScrollDirection::Up, 50.0),
        ScrollDelta { dx: 0.0, dy: -50.0 }
    );
    assert_eq!(
        scroll_delta(ScrollDirection::Left, 10.0),
        ScrollDelta { dx: -10.0, dy: 0.0 }
    );
    assert_eq!(
        scroll_delta(ScrollDirection::Right, 10.0),
        ScrollDelta { dx: 10.0, dy: 0.0 }
    );
}

#[test]
fn scrolls_three_hundred_pixels_by_default() {
    assert_eq!(DEFAULT_SCROLL_PX, 300.0);
}

#[test]
fn accepts_only_the_four_scroll_directions() {
    for direction in ["up", "down", "left", "right"] {
        assert!(is_scroll_direction(&json!(direction)), "{direction}");
    }
    for raw in [
        json!("Up"),
        json!("diagonal"),
        json!(""),
        json!(1),
        json!(null),
        json!(["up"]),
    ] {
        assert!(!is_scroll_direction(&raw), "{raw}");
    }
}

#[test]
fn matches_an_exact_code_a_class_like_2xx_and_a_range() {
    assert!(status_matches("404", Some(404)));
    assert!(status_matches("2xx", Some(204)));
    assert!(!status_matches("2xx", Some(301)));
    assert!(status_matches("400-499", Some(418)));
    assert!(!status_matches("400-499", Some(500)));
}

#[test]
fn never_matches_a_request_that_has_no_status_yet() {
    assert!(!status_matches("2xx", None));
}

#[test]
fn reads_a_class_in_any_case_and_only_for_the_digits_one_to_five() {
    assert!(status_matches("2XX", Some(200)));
    assert!(status_matches("5xx", Some(599)));
    assert!(status_matches("1xx", Some(101)));
    assert!(!status_matches("6xx", Some(600)));
    assert!(!status_matches("0xx", Some(99)));
    assert!(!status_matches("2xx", Some(99)));
    assert!(!status_matches("2xx", Some(300)));
}

#[test]
fn includes_both_ends_of_a_range_and_refuses_a_reversed_one() {
    assert!(status_matches("400-499", Some(400)));
    assert!(status_matches("400-499", Some(499)));
    assert!(!status_matches("400-499", Some(399)));
    assert!(!status_matches("499-400", Some(450)));
}

#[test]
fn compares_any_other_filter_as_text() {
    assert!(!status_matches("0404", Some(404)));
    assert!(!status_matches("abc", Some(404)));
    assert!(!status_matches("", Some(404)));
    assert!(!status_matches("40-499", Some(418)));
    assert!(!status_matches("400-4999", Some(418)));
    assert!(!status_matches("400-499\n", Some(418)));
}

#[test]
fn adds_https_when_the_scheme_is_missing() {
    assert_eq!(normalize_url("example.com"), "https://example.com");
}

#[test]
fn uses_http_for_loopback_hosts() {
    assert_eq!(
        normalize_url("localhost:3000/app"),
        "http://localhost:3000/app"
    );
    assert_eq!(normalize_url("127.0.0.1:8080"), "http://127.0.0.1:8080");
}

#[test]
fn keeps_urls_that_already_have_a_scheme() {
    assert_eq!(normalize_url("file:///tmp/a.html"), "file:///tmp/a.html");
    assert_eq!(normalize_url("about:blank"), "about:blank");
    assert_eq!(normalize_url("http://x.test"), "http://x.test");
}

#[test]
fn keeps_an_opaque_scheme_in_any_case() {
    for url in [
        "about:blank",
        "ABOUT:blank",
        "data:text/html,hi",
        "blob:https://x.test/1",
        "mailto:a@b.test",
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "ftp://x.test",
        "HTTP://X.TEST",
    ] {
        assert_eq!(normalize_url(url), url, "{url}");
    }
}

#[test]
fn reads_every_loopback_form_as_http() {
    let table = [
        ("localhost", "http://localhost"),
        ("LOCALHOST:3000", "http://LOCALHOST:3000"),
        ("localhost/app", "http://localhost/app"),
        ("127.1.2.3/x", "http://127.1.2.3/x"),
        ("[::1]", "http://[::1]"),
        ("[::1]:8080/x", "http://[::1]:8080/x"),
    ];
    for (raw, expected) in table {
        assert_eq!(normalize_url(raw), expected, "{raw}");
    }
}

#[test]
fn gives_https_to_a_host_that_only_starts_like_a_loopback_host() {
    let table = [
        ("localhost.evil.test", "https://localhost.evil.test"),
        ("localhostx:3000", "https://localhostx:3000"),
        ("127.0.0.1.evil.test", "https://127.0.0.1.evil.test"),
        ("localhost:abc", "https://localhost:abc"),
        ("127.\u{660}.0.1", "https://127.\u{660}.0.1"),
    ];
    for (raw, expected) in table {
        assert_eq!(normalize_url(raw), expected, "{raw}");
    }
}

#[test]
fn trims_the_text_with_the_js_space_set_before_it_decides() {
    assert_eq!(normalize_url("  example.com \n"), "https://example.com");
    assert_eq!(normalize_url("\u{feff}example.com"), "https://example.com");
    assert_eq!(normalize_url(" localhost:3000 "), "http://localhost:3000");
    assert_eq!(normalize_url("  about:blank  "), "about:blank");
}

#[test]
fn puts_a_scheme_in_front_of_empty_text() {
    assert_eq!(normalize_url(""), "https://");
    assert_eq!(normalize_url("   "), "https://");
}
