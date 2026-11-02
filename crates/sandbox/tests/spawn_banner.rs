#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::Platform;
use ostia_contract::dict::{en, zh_hant};
use ostia_contract::pane_banner_text::PaneBannerText;
use ostia_sandbox::spawn_banner::{hidden_home_notice, missing_packages, sandbox_failure_banner};
use ostia_testkit::fixture_text;

fn en_text() -> PaneBannerText {
    PaneBannerText::from_dict(en())
}

fn zh_text() -> PaneBannerText {
    PaneBannerText::from_dict(zh_hant())
}

fn strip_sgr(text: &str) -> String {
    text.replace("\x1b[2m", "").replace("\x1b[0m", "")
}

#[test]
fn tells_a_linux_shell_that_writes_to_the_hidden_home_folder_are_discarded_and_how_to_keep_them() {
    let notice = hidden_home_notice(&en_text(), Platform::Linux);
    assert!(notice.contains("your home folder is hidden here"));
    assert!(notice.contains("are discarded when this shell exits"));
    assert!(notice.contains("Add a writable folder"));
    assert!(notice.ends_with("\x1b[0m\r\n"));
    assert_eq!(
        notice,
        fixture_text("rust/hidden-home-notice-en.txt").unwrap()
    );
}

#[test]
fn fits_an_80_column_pane_without_wrapping() {
    let notice = strip_sgr(&hidden_home_notice(&en_text(), Platform::Linux));
    let widest = notice
        .split("\r\n")
        .map(|line| line.encode_utf16().count())
        .max()
        .unwrap();
    assert!(widest <= 80, "widest line is {widest}");
}

#[test]
fn says_nothing_on_macos_where_a_write_to_the_hidden_home_fails_with_an_error() {
    assert_eq!(hidden_home_notice(&en_text(), Platform::Darwin), "");
}

#[test]
fn names_the_packages_behind_the_missing_programs_and_how_to_install_them() {
    assert_eq!(
        missing_packages(&["bwrap not found", "socat is missing", "unrelated"]),
        vec!["bubblewrap", "socat"]
    );
    let banner = sandbox_failure_banner(&en_text(), "cannot start", &["bwrap not found"]);
    assert!(banner.contains("Sandbox unavailable: cannot start"));
    assert!(banner.contains("ostia system install bubblewrap"));
    assert!(banner.contains("No shell was started"));
}

#[test]
fn translates_the_sandbox_failure_banner_and_keeps_the_product_command() {
    let banner = sandbox_failure_banner(&zh_text(), "cannot start", &["bwrap not found"]);
    assert!(banner.contains("沙箱無法使用：cannot start"));
    assert!(banner.contains("缺少：bubblewrap"));
    assert!(banner.contains("ostia system install bubblewrap"));
    assert!(!banner.contains("Sandbox unavailable"));
    assert!(!banner.contains("No shell was started"));
    assert_eq!(
        banner,
        fixture_text("rust/sandbox-failure-banner-zh-hant.txt").unwrap()
    );
}

#[test]
fn translates_the_hidden_home_notice() {
    let notice = hidden_home_notice(&zh_text(), Platform::Linux);
    assert!(notice.contains("這個 shell 結束時捨棄"));
    assert_eq!(
        notice,
        fixture_text("rust/hidden-home-notice-zh-hant.txt").unwrap()
    );
}

#[test]
fn writes_the_same_bytes_as_ts_for_a_failure_with_two_missing_packages() {
    assert_eq!(
        sandbox_failure_banner(
            &en_text(),
            "cannot start",
            &["bwrap not found", "socat is missing"]
        ),
        fixture_text("rust/sandbox-failure-banner-en.txt").unwrap()
    );
}

#[test]
fn writes_no_missing_or_install_line_when_no_program_is_missing() {
    let banner = sandbox_failure_banner(&en_text(), "cannot start", &["unrelated"]);
    assert_eq!(
        banner,
        fixture_text("rust/sandbox-failure-banner-bare.txt").unwrap()
    );
    assert!(!banner.contains("Missing"));
    assert!(!banner.contains("system install"));
}

#[test]
fn lists_each_package_once_in_the_order_the_errors_name_them() {
    assert_eq!(
        missing_packages(&["socat is missing", "bubblewrap", "bwrap", "SOCAT again"]),
        vec!["socat", "bubblewrap"]
    );
}

#[test]
fn matches_ripgrep_by_name_or_as_the_whole_word_rg_and_ignores_case() {
    let cases: [(&str, bool); 6] = [
        ("ripgrep not found", true),
        ("RIPGREP", true),
        ("rg: command not found", true),
        ("(rg)", true),
        ("org chart", false),
        ("rgb", false),
    ];
    for (error, expected) in cases {
        assert_eq!(
            missing_packages(&[error]) == vec!["ripgrep"],
            expected,
            "{error}"
        );
    }
}

#[test]
fn finds_nothing_in_an_empty_error_list() {
    assert!(missing_packages(&[]).is_empty());
}
