#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::pane_banner::{error_banner, integration_not_loaded_notice};
use ostia_testkit::fixture_text;

const EN_TEMPLATE: &str = "Shell integration not loaded ({reason}): this shell runs without prompt marks, the CLI or agent hooks. Open a new pane to try again.";
const ZH_HANT_TEMPLATE: &str = "未載入 shell 整合（{reason}）：這個 shell 沒有提示字元標記、CLI 與 agent hook。開新的窗格即可重試。";

#[test]
fn says_the_shell_integration_is_not_loaded_with_the_reason_in_both_languages() {
    let en = integration_not_loaded_notice(EN_TEMPLATE, "ENOSPC");
    assert!(en.contains("Shell integration not loaded (ENOSPC)"));
    assert_eq!(
        en,
        fixture_text("rust/pane-banner-integration-en.txt").unwrap()
    );
    let zh = integration_not_loaded_notice(ZH_HANT_TEMPLATE, "EACCES");
    assert!(zh.contains("未載入 shell 整合（EACCES）"));
    assert!(!zh.contains("Shell integration"));
    assert_eq!(
        zh,
        fixture_text("rust/pane-banner-integration-zh-hant.txt").unwrap()
    );
}

#[test]
fn wraps_an_error_banner_in_the_red_sgr_between_line_breaks_as_the_ts_code_does() {
    assert_eq!(
        error_banner("Sandbox unavailable"),
        fixture_text("rust/pane-banner-error.txt").unwrap()
    );
}

#[test]
fn leaves_an_unknown_placeholder_in_the_notice_text() {
    let notice = integration_not_loaded_notice("{reason} and {other}", "ENOSPC");
    assert!(notice.contains("ENOSPC and {other}"));
}
