#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::{Duration, Instant};

use ostia_contract::external_links::{
    BrowserPage, ExternalLinkPolicy, LinkKind, app_link_scheme, browser_page_of, external_href,
    find_app_links, find_scheme_links, link_kind,
};

const VAULT: &str = "obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中文.md&newpane=true";
const VAULT_HREF: &str = "obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=05%20Projects/%E4%B8%AD%E6%96%87.md&newpane=true";

fn href(url: &str, apps: bool) -> Option<String> {
    external_href(url, ExternalLinkPolicy { apps })
}

fn urls(text: &str) -> Vec<String> {
    find_app_links(text)
        .into_iter()
        .map(|link| link.url)
        .collect()
}

fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16(&units[start..end]).unwrap()
}

#[test]
fn opens_obsidian_and_vscode_links_only_when_apps_are_allowed() {
    for url in [
        "obsidian://open?vault=a",
        "vscode://file/a.ts",
        "vscode-insiders://file/a",
    ] {
        assert_eq!(href(url, true).as_deref(), Some(url), "{url}");
        assert_eq!(href(url, false), None, "{url}");
    }
}

#[test]
fn keeps_web_and_mail_links_open_under_both_policies() {
    for apps in [true, false] {
        assert_eq!(
            href("https://example.com/a", apps).as_deref(),
            Some("https://example.com/a")
        );
        assert_eq!(
            href("mailto:a@example.com", apps).as_deref(),
            Some("mailto:a@example.com")
        );
    }
}

#[test]
fn blocks_scripts_files_data_and_unknown_schemes() {
    for url in [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,<b>x</b>",
        "not a url",
    ] {
        assert_eq!(href(url, true), None, "{url}");
    }
}

#[test]
fn opens_any_other_scheme_with_a_double_slash_only_when_apps_are_allowed() {
    for url in [
        "slack://channel?id=1",
        "zed://file/tmp/a",
        "x-custom://do",
        "ssh://host",
    ] {
        assert_eq!(href(url, true).as_deref(), Some(url), "{url}");
        assert_eq!(href(url, false), None, "{url}");
    }
    assert_eq!(
        href("Zed://file/My Dir/a", true).as_deref(),
        Some("zed://file/My%20Dir/a")
    );
}

#[test]
fn refuses_dangerous_and_internal_schemes_in_any_form() {
    for url in [
        "javascript://x%0Aalert(1)",
        "JAVASCRIPT://x",
        "vbscript://x",
        "data://x",
        "blob://x",
        "about://blank",
        "chrome-extension://abc/x",
        "chrome-untrusted://abc/x",
        "devtools://devtools/bundled/x.html",
        "view-source://https://a.b",
        "filesystem://x",
        "file://host/etc/passwd",
        "ostia://settings-schema",
        "ostia-preview://slot/index.html",
        "remote://folder/a.ts",
        "untitled://a",
        "app://index.html",
    ] {
        assert_eq!(href(url, true), None, "{url}");
        assert_eq!(link_kind(url), None, "{url}");
    }
}

#[test]
fn treats_chrome_edge_and_brave_pages_as_app_links_that_name_their_browser() {
    for (url, page, scheme) in [
        (
            "chrome://inspect/#remote-debugging",
            BrowserPage::Chrome,
            "chrome",
        ),
        ("edge://settings", BrowserPage::Edge, "edge"),
        ("brave://settings", BrowserPage::Brave, "brave"),
    ] {
        assert_eq!(link_kind(url), Some(LinkKind::External), "{url}");
        assert_eq!(href(url, false), None, "{url}");
        assert_eq!(
            href(url, true),
            Some(url::Url::parse(url).unwrap().to_string()),
            "{url}"
        );
        assert_eq!(browser_page_of(url), Some(page), "{url}");
        assert_eq!(app_link_scheme(url).as_deref(), Some(scheme), "{url}");
    }
    assert_eq!(browser_page_of("obsidian://open"), None);
    assert_eq!(browser_page_of("chrome:settings"), None);
}

#[test]
fn names_the_scheme_of_an_app_link_never_of_a_web_or_mail_link() {
    assert_eq!(
        app_link_scheme("obsidian://open?vault=a").as_deref(),
        Some("obsidian")
    );
    assert_eq!(app_link_scheme("https://a.b"), None);
    assert_eq!(app_link_scheme("mailto:a@b.c"), None);
    assert_eq!(app_link_scheme("javascript:alert(1)"), None);
}

#[test]
fn refuses_schemes_that_mount_remote_folders_or_reach_windows_handlers() {
    for url in [
        "smb://host/share",
        "cifs://host/share",
        "afp://host/share",
        "nfs://host/export",
        "ftp://host/a",
        "ftps://host/a",
        "dav://host/a",
        "davs://host/a",
        "webdav://host/a",
        "search://query",
        r"search-ms://query=a&crumb=location:\\h\s",
        "ms-msdt://id",
        "ms-officecmd://x",
        "MS-Excel://ofe|u|http://h/a.xlsx",
    ] {
        assert_eq!(href(url, true), None, "{url}");
        assert_eq!(link_kind(url), None, "{url}");
    }
}

#[test]
fn keeps_everyday_app_schemes_open() {
    for url in [
        "msteams://teams.microsoft.com/l/chat/0/0",
        "vnc://host:5900",
        "ssh://host:22",
        "tel://+886212345678",
        "facetime://+886212345678",
        "x-apple.systempreferences://com.apple.preference.security",
        "steam://run/440",
    ] {
        assert_eq!(link_kind(url), Some(LinkKind::External), "{url}");
        assert!(href(url, true).is_some(), "{url}");
    }
}

#[test]
fn refuses_credentials_in_links_of_schemes_outside_the_list() {
    for url in ["postgres://u:p@h/db", "redis://:pw@h", "ssh://me:pw@host"] {
        assert_eq!(href(url, true), None, "{url}");
        assert_eq!(link_kind(url), None, "{url}");
    }
    assert_eq!(
        href("https://u:p@example.com/", false).as_deref(),
        Some("https://u:p@example.com/")
    );
    assert_eq!(
        href("vscode://u:p@file/a", true).as_deref(),
        Some("vscode://u:p@file/a")
    );
    assert!(urls("db postgres://u:p@h/db or <redis://:pw@h>").is_empty());
}

#[test]
fn opens_links_that_carry_only_a_user_name() {
    for url in ["ssh://me@host", "vnc://me@host:5900"] {
        assert_eq!(link_kind(url), Some(LinkKind::External), "{url}");
        assert_eq!(href(url, true).as_deref(), Some(url), "{url}");
    }
    assert_eq!(urls("run ssh://me@host now"), ["ssh://me@host"]);
}

#[test]
fn refuses_a_scheme_that_is_too_short_or_has_no_double_slash() {
    for url in ["a://b", "x-custom:do", "foo::bar", "C://Windows"] {
        assert_eq!(href(url, true), None, "{url}");
        assert_eq!(link_kind(url), None, "{url}");
    }
}

#[test]
fn encodes_spaces_and_non_ascii_characters_without_encoding_twice() {
    assert_eq!(href(VAULT, true).as_deref(), Some(VAULT_HREF));
    assert_eq!(href(VAULT_HREF, true).as_deref(), Some(VAULT_HREF));
    assert_eq!(
        href("VSCODE://file/My Dir/a.ts:3", true).as_deref(),
        Some("vscode://file/My%20Dir/a.ts:3")
    );
}

#[test]
fn sends_web_links_to_the_browser_and_app_links_to_the_system() {
    assert_eq!(link_kind("https://example.com"), Some(LinkKind::Browser));
    assert_eq!(link_kind(VAULT), Some(LinkKind::External));
    assert_eq!(link_kind("vscode://file/a"), Some(LinkKind::External));
    assert_eq!(link_kind("mailto:a@example.com"), Some(LinkKind::External));
    assert_eq!(link_kind("slack://channel?id=1"), Some(LinkKind::External));
}

#[test]
fn refuses_everything_else() {
    assert_eq!(link_kind("javascript:alert(1)"), None);
    assert_eq!(link_kind("file:///etc/passwd"), None);
    assert_eq!(link_kind("x-custom:do"), None);
    assert_eq!(link_kind(""), None);
}

#[test]
fn finds_a_markdown_target_in_angle_brackets_with_spaces_and_chinese() {
    let text = format!("see [中文](<{VAULT}>) now");
    let links = find_app_links(&text);
    assert_eq!(links[0].url, VAULT);
    assert_eq!(utf16_slice(&text, links[0].start, links[0].end), VAULT);
}

#[test]
fn finds_plain_links_and_trims_trailing_punctuation_and_closing_brackets() {
    let text = "open obsidian://open?vault=Notes&file=中文筆記, or (vscode://file/a.ts:12).";
    assert_eq!(
        urls(text),
        [
            "obsidian://open?vault=Notes&file=中文筆記",
            "vscode://file/a.ts:12"
        ]
    );
}

#[test]
fn stops_a_plain_link_at_full_width_punctuation() {
    assert_eq!(
        urls("打開 obsidian://open?file=筆記（草稿）"),
        ["obsidian://open?file=筆記"]
    );
}

#[test]
fn keeps_a_bracket_that_belongs_to_the_link() {
    assert_eq!(
        urls("[n](vscode://file/a(1).ts)"),
        ["vscode://file/a(1).ts"]
    );
}

#[test]
fn trims_a_long_run_of_closing_brackets_and_punctuation_in_linear_time() {
    let started = Instant::now();
    let closers = urls(&format!("obsidian://a{}", ")".repeat(50_000)));
    assert!(started.elapsed() < Duration::from_secs(1));
    let mixed = urls(&format!("vscode://file/a{}", ".)]".repeat(10_000)));
    assert_eq!(closers, ["obsidian://a"]);
    assert_eq!(mixed, ["vscode://file/a"]);
}

#[test]
fn ignores_web_file_blocked_and_empty_links_and_schemes_inside_a_word() {
    assert!(
        urls("https://a.b/zed://x file:///tmp/a javascript://x ostia-preview://s obsidian:// _zed://x")
            .is_empty()
    );
}

#[test]
fn finds_plain_and_bracketed_links_of_any_scheme() {
    let text = "go slack://channel?id=1, then <zed://file/My Dir/a.ts> or (x-app+v1.2://do).";
    assert_eq!(
        urls(text),
        [
            "slack://channel?id=1",
            "zed://file/My Dir/a.ts",
            "x-app+v1.2://do"
        ]
    );
}

#[test]
fn does_not_link_short_schemes_code_without_a_double_slash_or_text_after_chinese_punctuation() {
    assert!(urls("a://b std::vector foo::bar://x C://Win").is_empty());
    assert_eq!(
        urls("開 zed://file/a，然後（slack://x）"),
        ["zed://file/a", "slack://x"]
    );
}

#[test]
fn scans_a_long_run_of_scheme_characters_in_linear_time() {
    let started = Instant::now();
    let text = format!("{}:/ {}", "a+".repeat(50_000), "ab".repeat(50_000));
    assert!(urls(&text).is_empty());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn counts_offsets_in_utf16_units_and_keeps_only_links_the_filter_accepts() {
    let text = "😀 zed://a <zed://b> slack://c";
    let links = find_scheme_links(text, &|url| url != "slack://c");
    let found: Vec<(&str, String)> = links
        .iter()
        .map(|link| (link.url.as_str(), utf16_slice(text, link.start, link.end)))
        .collect();
    assert_eq!(
        found,
        [
            ("zed://a", "zed://a".to_owned()),
            ("zed://b", "zed://b".to_owned())
        ]
    );
    assert_eq!(links[0].start, 3);
}

#[test]
fn rejects_a_scheme_that_follows_a_link_character_and_finds_one_after_a_space() {
    for text in ["x/zed://a", "x:zed://a", "_zed://a", "9zed://a"] {
        assert!(urls(text).is_empty(), "{text}");
    }
    assert_eq!(urls("x zed://a"), ["zed://a"]);
}
