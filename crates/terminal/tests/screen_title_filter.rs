#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::screen_title_filter::ScreenTitleFilter;

fn at_every_offset(input: &str, expected: &str) {
    for i in 1..input.len() {
        let mut f = ScreenTitleFilter::new();
        let out = f.push(&input[..i]) + &f.push(&input[i..]);
        assert_eq!(out, expected, "offset {i}");
    }
}

#[test]
fn strips_esc_k_title_esc_backslash_in_one_chunk() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("a\x1bkpwd\x1b\\b"), "ab");
}

#[test]
fn strips_the_sequence_split_across_chunks_at_every_offset() {
    at_every_offset("a\x1bkcd /tmp\x1b\\b", "ab");
}

#[test]
fn keeps_osc_titles_and_other_escapes_unchanged() {
    let mut f = ScreenTitleFilter::new();
    let input = "\x1b]0;title\x07\x1b]2;t\x1b\\\x1b[31mred\x1b[0m\x1bM";
    assert_eq!(f.push(input), input);
}

#[test]
fn does_not_end_the_title_on_bel() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("\x1bkt\x07x\x1b\\y"), "y");
}

#[test]
fn drops_an_aborted_title_on_can_and_resumes_output() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("\x1bkabc\x18z"), "z");
}

#[test]
fn drops_an_aborted_title_on_sub_and_resumes_output() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("\x1bkabc\x1az"), "z");
}

#[test]
fn ends_the_title_at_any_esc_and_parses_what_follows() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("\x1bkt\x1b[31my"), "\x1b[31my");
}

#[test]
fn keeps_a_colored_prompt_after_an_unterminated_title() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(
        f.push("a\x1bkt\x1b[31mred\x1b[0m$ "),
        "a\x1b[31mred\x1b[0m$ "
    );
}

#[test]
fn keeps_command_output_after_a_bel_inside_the_title() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(
        f.push("\x1bkvim\x07\x1b[32muser@host\x1b[0m $ ls\r\nfile\r\n"),
        "\x1b[32muser@host\x1b[0m $ ls\r\nfile\r\n"
    );
}

#[test]
fn drops_the_first_esc_of_esc_esc_like_tmux() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("a\x1b\x1bkt\x1b\\b"), "ab");
}

#[test]
fn starts_a_new_title_when_esc_k_follows_inside_a_title() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("\x1bka\x1bkb\x1b\\c"), "c");
}

#[test]
fn keeps_swallowing_a_title_longer_than_any_limit_until_esc() {
    let mut f = ScreenTitleFilter::new();
    let title = "x".repeat(2 * 1024 * 1024);
    assert_eq!(f.push(&format!("\x1bk{title}")), "");
    assert_eq!(f.push("more\x1b\\ok"), "ok");
}

#[test]
fn treats_esc_k_after_a_c0_control_as_a_title_like_tmux() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("a\x1b\nkt\x1b\\b"), "a\nb");
}

#[test]
fn ignores_del_after_esc_like_tmux_and_still_starts_a_title() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("a\x1b\x7fkt\x1b\\b"), "ab");
}

#[test]
fn ignores_every_byte_from_del_up_after_esc_not_only_del() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("a\x1b\x7f\u{e9}\u{4e2d}kt\x1b\\b"), "ab");
}

#[test]
fn ignores_del_after_the_esc_that_ends_a_title() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("\x1bkt\x1b\x7f\\ok"), "ok");
}

#[test]
fn swallows_an_esc_del_k_title_split_across_chunks_at_every_offset() {
    at_every_offset("a\x1b\x7fkcd /tmp\x1b\x7f\\b", "ab");
}

#[test]
fn drops_bytes_from_del_up_after_esc_and_keeps_the_sequence_that_follows() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(f.push("a\x1b\x7fMb"), "a\x1bMb");
}

#[test]
fn does_not_hold_cjk_text_after_a_stray_esc() {
    let mut f = ScreenTitleFilter::new();
    assert_eq!(
        f.push("\x1b\u{4e2d}\u{6587}\r\n\u{4e2d}\u{6587}\r\n"),
        "\r\n\r\n"
    );
    for _ in 0..1000 {
        assert_eq!(f.push("\u{4e2d}\u{6587}\u{4e2d}\u{6587}\r\n"), "\r\n");
    }
    assert_eq!(f.push("x"), "\x1bx");
}

#[test]
fn returns_plain_text_unchanged() {
    let mut f = ScreenTitleFilter::new();
    let input = "plain \u{e9}\u{4e2d}\r\n";
    assert_eq!(f.push(input), input);
}
