#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::js::utf16_len;
use ostia_model::terminal::terminal_title::{TERMINAL_TITLE_MAX, terminal_title};

#[test]
fn keeps_an_agents_task_title_as_it_set_it() {
    assert_eq!(
        terminal_title("✳ Review and merge PR #5500").as_deref(),
        Some("✳ Review and merge PR #5500")
    );
}

#[test]
fn drops_control_characters_and_surrounding_space() {
    assert_eq!(
        terminal_title("  build\x07 done\x1b ").as_deref(),
        Some("build done")
    );
}

#[test]
fn ignores_a_title_that_is_empty_once_cleaned() {
    assert_eq!(terminal_title(" \x07 "), None);
}

#[test]
fn caps_a_long_title_with_an_ellipsis() {
    let title = terminal_title(&"x".repeat(500)).unwrap();
    assert_eq!(utf16_len(&title), TERMINAL_TITLE_MAX);
    assert!(title.ends_with('…'));
}

#[test]
fn keeps_a_title_of_exactly_the_cap_and_caps_one_unit_longer() {
    let exact = "y".repeat(TERMINAL_TITLE_MAX);
    assert_eq!(terminal_title(&exact).as_deref(), Some(exact.as_str()));
    let capped = terminal_title(&"y".repeat(TERMINAL_TITLE_MAX + 1)).unwrap();
    assert_eq!(utf16_len(&capped), TERMINAL_TITLE_MAX);
    assert_eq!(capped, format!("{}…", "y".repeat(TERMINAL_TITLE_MAX - 1)));
}

#[test]
fn removes_c1_controls_and_keeps_other_invisible_characters_inside() {
    assert_eq!(
        terminal_title("a\u{85}b\u{7f}c\u{200b}d").as_deref(),
        Some("abc\u{200b}d")
    );
}

#[test]
fn trims_with_the_javascript_space_set() {
    assert_eq!(
        terminal_title("\u{feff}\u{a0} name \u{2028}").as_deref(),
        Some("name")
    );
}

#[test]
fn trims_after_the_control_characters_are_gone() {
    assert_eq!(terminal_title("\x07  tab \x1b").as_deref(), Some("tab"));
}
