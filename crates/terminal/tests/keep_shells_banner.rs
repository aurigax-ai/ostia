#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::keep_shells_banner::{keep_shells_notice, tmux_missing};
use ostia_testkit::fixture_text;

const EN_TMUX_MISSING: &str = "tmux {version} or newer is not installed";
const EN_KEEP_SHELLS: &str = "Keep shells: {reason}.";
const EN_KEEP_SHELLS_LOST: &str = "This shell will not survive a restart.";
const ZH_TMUX_MISSING: &str = "未安裝 tmux {version} 或更新版本";
const ZH_KEEP_SHELLS: &str = "保留 shell：{reason}。";
const ZH_KEEP_SHELLS_LOST: &str = "這個 shell 無法在重新啟動後保留。";

fn en_notice(reason: &str) -> String {
    keep_shells_notice(EN_KEEP_SHELLS, EN_KEEP_SHELLS_LOST, reason)
}

#[test]
fn ksh_c63_says_why_the_shell_is_not_kept_and_that_it_will_not_survive_a_restart() {
    let notice = en_notice(&tmux_missing(EN_TMUX_MISSING));
    assert!(notice.contains("tmux 3.2 or newer is not installed"));
    assert!(notice.contains("This shell will not survive a restart."));
    assert!(!notice.contains("No shell was started"));
    assert_eq!(
        notice,
        fixture_text("rust/keep-shells-notice-en.txt").unwrap()
    );
}

#[test]
fn keeps_a_multi_line_reason_on_one_line_and_drops_control_characters() {
    let notice = en_notice("tmux could not start its server: line one\n\x1b]0;x\x07two");
    assert!(notice.contains("tmux could not start its server: line one ]0;x two."));
    assert_eq!(notice.matches('\x1b').count(), 2);
}

#[test]
fn writes_the_same_bytes_as_ts_for_a_reason_with_control_characters_and_runs_of_spaces() {
    assert_eq!(
        en_notice("tmux could not start its server: line one\n\x1b]0;x\x07two  \x7f three"),
        fixture_text("rust/keep-shells-notice-multiline.txt").unwrap()
    );
}

#[test]
fn writes_the_same_bytes_as_ts_in_traditional_chinese() {
    let notice = keep_shells_notice(
        ZH_KEEP_SHELLS,
        ZH_KEEP_SHELLS_LOST,
        &tmux_missing(ZH_TMUX_MISSING),
    );
    assert_eq!(
        notice,
        fixture_text("rust/keep-shells-notice-zh-hant.txt").unwrap()
    );
}

#[test]
fn puts_the_minimum_tmux_version_in_the_missing_text() {
    assert_eq!(
        tmux_missing(EN_TMUX_MISSING),
        "tmux 3.2 or newer is not installed"
    );
}

#[test]
fn leaves_an_unknown_placeholder_in_the_text() {
    assert_eq!(tmux_missing("{version} and {other}"), "3.2 and {other}");
}

#[test]
fn trims_a_reason_and_squeezes_runs_of_spaces() {
    let notice = en_notice("  a \t\t b   c  ");
    assert!(notice.contains("Keep shells: a b c."));
}

#[test]
fn drops_the_delete_character_and_every_character_below_a_space() {
    let notice = en_notice("a\x00b\x1fc\x7fd");
    assert!(notice.contains("Keep shells: a b c d."));
}

#[test]
fn ends_the_notice_with_a_reset_and_a_line_break() {
    let notice = en_notice("x");
    assert!(notice.starts_with("\x1b[2m "));
    assert!(notice.ends_with("restart.\x1b[0m\r\n"));
    assert!(notice.contains(".\r\n This shell"));
}
