#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::html_preview::{
    PREVIEW_SCHEME, PreviewError, PreviewErrorKind, allows_preview_request, blocked_by_policy,
    blocked_host, is_component_path, is_preview_partition, is_preview_path, is_web_link,
    keep_errors, normalize_preview_theme, preview_error_line, preview_partition,
};
use ostia_contract::portable::PORTABLE_CSP;
use serde_json::{Value, json};

fn error(message: &str) -> PreviewError {
    PreviewError {
        kind: PreviewErrorKind::Error,
        message: message.to_owned(),
        source: None,
        line: None,
    }
}

fn theme(value: Value) -> Value {
    serde_json::to_value(normalize_preview_theme(&value)).unwrap()
}

#[test]
fn lets_a_session_load_only_its_own_scheme() {
    assert_eq!(PREVIEW_SCHEME, "ostia-preview");
    assert!(allows_preview_request("ostia-preview://abc/"));
    assert!(allows_preview_request("ostia-preview://abc/data.json"));
    for url in [
        "http://127.0.0.1:8080/",
        "https://example.com/a.js",
        "ws://127.0.0.1:1/",
        "wss://example.com/",
        "file:///etc/passwd",
        "ftp://example.com/",
        "ostia-previewx://abc/",
        "chrome://settings",
    ] {
        assert!(!allows_preview_request(url), "{url}");
    }
}

#[test]
fn uses_a_partition_that_is_never_persisted() {
    assert_eq!(preview_partition("abc"), "ostia-preview-abc");
    assert!(!preview_partition("abc").starts_with("persist:"));
    assert!(is_preview_partition(Some("ostia-preview-abc")));
    assert!(!is_preview_partition(Some("persist:ostia-browser")));
    assert!(!is_preview_partition(None));
}

#[test]
fn previews_html_htm_jsx_and_tsx() {
    assert!(is_preview_path(Some("/a/page.html")));
    assert!(is_preview_path(Some("/a/PAGE.HTM")));
    assert!(!is_preview_path(Some("/a/page.html.md")));
    assert!(is_preview_path(Some("/a/App.tsx")));
    assert!(is_preview_path(Some("/a/App.jsx")));
    assert!(!is_preview_path(Some("/a/lib.ts")));
    assert!(is_component_path(Some("/a/App.tsx")));
    assert!(!is_component_path(Some("/a/page.html")));
    assert!(!is_preview_path(None));
}

#[test]
fn matches_the_extension_at_the_end_only_and_ignores_case() {
    for (path, component, preview) in [
        ("/a/App.TSX", true, true),
        ("/a/App.Jsx", true, true),
        ("/a/App.tsx.bak", false, false),
        ("/a/App.ts", false, false),
        ("/a/html", false, false),
        ("/a/.html", false, true),
        ("/a/page.xhtml", false, false),
        ("", false, false),
    ] {
        assert_eq!(is_component_path(Some(path)), component, "{path}");
        assert_eq!(is_preview_path(Some(path)), preview, "{path}");
    }
    assert!(!is_component_path(None));
}

#[test]
fn names_the_host_a_policy_refusal_was_for_in_both_wordings_chromium_uses() {
    assert_eq!(
        blocked_by_policy(
            "Refused to connect to 'http://127.0.0.1:4000/fetch' because it violates the following Content Security Policy directive: \"connect-src ostia-preview:\"."
        )
        .as_deref(),
        Some("127.0.0.1:4000")
    );
    assert_eq!(
        blocked_by_policy(
            "Loading the image 'https://example.com/a.png' violates the following Content Security Policy directive: \"img-src ostia-preview: data: blob:\"."
        )
        .as_deref(),
        Some("example.com")
    );
    assert_eq!(
        blocked_by_policy(
            "Fetch API cannot load http://127.0.0.1:40583/from-component. Refused to connect because it violates the document's Content Security Policy."
        )
        .as_deref(),
        Some("127.0.0.1:40583")
    );
    assert_eq!(
        blocked_by_policy("Uncaught ReferenceError: x is not defined at 'http://a/'"),
        None
    );
    assert_eq!(
        blocked_by_policy(
            "Refused to create a worker from 'ostia-preview://abc/w.js' because it violates the following Content Security Policy directive"
        ),
        None
    );
}

#[test]
fn matches_the_policy_words_in_any_case_and_trims_trailing_punctuation_from_the_url() {
    assert_eq!(
        blocked_by_policy(
            "Fetch API cannot load http://example.com. Refused because of the content security policy."
        )
        .as_deref(),
        Some("example.com")
    );
    assert_eq!(
        blocked_by_policy("Content Security Policy blocked wss://example.com:9/x;").as_deref(),
        Some("example.com:9")
    );
    assert_eq!(
        blocked_by_policy("Content Security Policy blocked something with no address"),
        None
    );
}

#[test]
fn names_a_host_or_the_scheme_when_there_is_none() {
    assert_eq!(blocked_host("wss://example.com:9/x"), "example.com:9");
    assert_eq!(blocked_host("file:///etc/passwd"), "file");
}

#[test]
fn names_the_scheme_of_a_url_with_no_host_and_the_first_80_characters_of_a_bad_one() {
    assert_eq!(blocked_host("javascript:alert(1)"), "javascript");
    assert_eq!(blocked_host("http://EXAMPLE.com:80/a"), "example.com");
    let bad = format!("no scheme {}", "x".repeat(100));
    assert_eq!(blocked_host(&bad), bad.chars().take(80).collect::<String>());
    assert_eq!(blocked_host("short"), "short");
}

#[test]
fn keeps_the_newest_8_kib_of_messages() {
    let mut kept: Vec<PreviewError> = Vec::new();
    for i in 0..10 {
        kept = keep_errors(&kept, error(&i.to_string().repeat(1000)), 4000);
    }
    let firsts: Vec<char> = kept
        .iter()
        .map(|e| e.message.chars().next().unwrap())
        .collect();
    assert_eq!(firsts, ['6', '7', '8', '9']);
    assert_eq!(
        keep_errors(&[], error(&"x".repeat(9000)), 4000)[0]
            .message
            .chars()
            .count(),
        4000
    );
}

#[test]
fn counts_message_length_in_characters_of_the_basic_plane() {
    let kept = keep_errors(&[], error(&"字".repeat(9000)), 4000);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].message, "字".repeat(4000));
}

#[test]
fn keeps_the_other_fields_of_a_cut_error() {
    let long = PreviewError {
        kind: PreviewErrorKind::Blocked,
        message: "y".repeat(50),
        source: Some("page.html".to_owned()),
        line: Some(7),
    };
    let kept = keep_errors(&[], long, 10);
    assert_eq!(kept[0].message, "y".repeat(10));
    assert_eq!(kept[0].kind, PreviewErrorKind::Blocked);
    assert_eq!(kept[0].source.as_deref(), Some("page.html"));
    assert_eq!(kept[0].line, Some(7));
}

#[test]
fn adds_the_position_an_error_has() {
    assert_eq!(
        preview_error_line(&PreviewError {
            kind: PreviewErrorKind::Error,
            message: "Uncaught Error: boom".to_owned(),
            source: Some("page.html".to_owned()),
            line: Some(12),
        }),
        "Uncaught Error: boom (page.html:12)"
    );
    assert_eq!(preview_error_line(&error("no position")), "no position");
    assert_eq!(
        preview_error_line(&PreviewError {
            line: Some(3),
            ..error("line only")
        }),
        "line only (line 3)"
    );
}

#[test]
fn shows_line_zero_and_ignores_a_source_without_a_line() {
    assert_eq!(
        preview_error_line(&PreviewError {
            line: Some(0),
            ..error("zero")
        }),
        "zero (line 0)"
    );
    assert_eq!(
        preview_error_line(&PreviewError {
            source: Some("page.html".to_owned()),
            ..error("no line")
        }),
        "no line"
    );
    assert_eq!(
        preview_error_line(&PreviewError {
            source: Some(String::new()),
            line: Some(4),
            ..error("empty source")
        }),
        "empty source (line 4)"
    );
}

#[test]
fn offers_the_browser_pane_only_for_web_links() {
    assert!(is_web_link("https://example.com/"));
    assert!(is_web_link("HTTP://example.com/"));
    assert!(!is_web_link("file:///etc/passwd"));
    assert!(!is_web_link("javascript:alert(1)"));
}

#[test]
fn a_portable_file_allows_no_script_source_but_itself_and_inline_code() {
    for (name, csp) in [("PRT-C14 a portable file", PORTABLE_CSP)] {
        let directives: Vec<&str> = csp.split("; ").collect();
        assert!(directives.contains(&"default-src 'none'"), "{name}");
        let script = directives
            .iter()
            .find(|d| d.starts_with("script-src "))
            .copied()
            .unwrap_or("");
        for source in script.split(' ').skip(1) {
            let nonce = source
                .strip_prefix("'nonce-")
                .and_then(|rest| rest.strip_suffix('\''))
                .is_some_and(|id| {
                    !id.is_empty()
                        && id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                });
            assert!(
                source == "'unsafe-inline'" || nonce || source == "ostia-preview:",
                "{name}: {source}"
            );
        }
    }
}

#[test]
fn takes_only_ostia_names_with_plain_values_from_the_window() {
    assert_eq!(
        theme(json!({
            "dark": true,
            "vars": {
                "--ostia-bg": "#1d2022",
                "--ostia-font": "Inter, \"Noto Sans\", sans-serif",
                "--ostia-fg": "oklch(0.9 0.01 240)",
                "--other": "red",
                "--ostia-x": "red;}</style><script>alert(1)</script>",
                "--ostia-url": "url(http://example.com/a.png)",
                "--ostia-n": 5,
            },
        })),
        json!({
            "dark": true,
            "vars": {
                "--ostia-bg": "#1d2022",
                "--ostia-font": "Inter, \"Noto Sans\", sans-serif",
                "--ostia-fg": "oklch(0.9 0.01 240)",
            },
        })
    );
    assert_eq!(theme(Value::Null), json!({"dark": false, "vars": {}}));
    assert_eq!(
        theme(json!({"dark": "yes", "vars": "x"})),
        json!({"dark": false, "vars": {}})
    );
}

#[test]
fn trims_a_value_and_checks_the_name_length_and_the_value_length() {
    let name_32 = format!("--ostia-{}", "a".repeat(32));
    let name_33 = format!("--ostia-{}", "a".repeat(33));
    let value_160 = "a".repeat(160);
    let value_161 = "a".repeat(161);
    let mut vars = serde_json::Map::new();
    vars.insert("--ostia-pad".to_owned(), json!("  #fff \n"));
    vars.insert(name_32.clone(), json!("1"));
    vars.insert(name_33, json!("1"));
    vars.insert("--ostia-long".to_owned(), json!(value_160.clone()));
    vars.insert("--ostia-longer".to_owned(), json!(value_161));
    vars.insert("--ostia-empty".to_owned(), json!(""));
    vars.insert("--ostia-blank".to_owned(), json!("   "));
    vars.insert("--ostia-Upper".to_owned(), json!("1"));
    vars.insert("--ostia-1".to_owned(), json!("1"));
    vars.insert("--ostia-".to_owned(), json!("1"));
    vars.insert("--ostia-brace".to_owned(), json!("a{b}"));
    let result = theme(json!({"vars": vars}));
    assert_eq!(
        result["vars"],
        json!({
            "--ostia-pad": "#fff",
            name_32: "1",
            "--ostia-long": value_160,
            "--ostia-blank": "",
        })
    );
}

#[test]
fn keeps_at_most_16_variables_in_the_order_given() {
    let mut vars = serde_json::Map::new();
    for i in 0..20 {
        let name = format!("--ostia-{}", (b'a' + i) as char);
        vars.insert(name, json!(i.to_string()));
    }
    let result = theme(json!({"dark": true, "vars": vars}));
    let kept = result["vars"].as_object().unwrap();
    assert_eq!(kept.len(), 16);
    assert_eq!(kept.keys().next().unwrap(), "--ostia-a");
    assert_eq!(kept.keys().next_back().unwrap(), "--ostia-p");
}

#[test]
fn counts_only_variables_that_passed_toward_the_limit_of_16() {
    let mut vars = serde_json::Map::new();
    for i in 0..10 {
        vars.insert(format!("--bad-{i}"), json!("1"));
    }
    for i in 0..16 {
        vars.insert(format!("--ostia-{}", (b'a' + i) as char), json!("1"));
    }
    let result = theme(json!({"vars": vars}));
    assert_eq!(result["vars"].as_object().unwrap().len(), 16);
}

#[test]
fn takes_dark_only_when_it_is_exactly_true() {
    for (dark, want) in [
        (json!(true), true),
        (json!(1), false),
        (json!("true"), false),
        (json!(false), false),
        (Value::Null, false),
    ] {
        assert_eq!(theme(json!({"dark": dark}))["dark"], json!(want), "{dark}");
    }
    assert_eq!(theme(json!([1, 2])), json!({"dark": false, "vars": {}}));
}
