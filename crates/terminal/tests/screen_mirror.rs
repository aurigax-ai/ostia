#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::Arc;

use history_support::{HistoryOptions, make_history};
use ostia_contract::osc7::CwdReport;
use ostia_terminal::headless_screen::HeadlessScreen;
use ostia_terminal::history_feed::{SpillClient, SpillPort};
use ostia_terminal::screen_mirror::{HISTORY_LINES, ScreenMirror, hibernate_seam, restore_seam};
use ostia_terminal::spill_host::{SpillEvent, SpillRequest};
use regex::Regex;

const WIDE: u16 = 127;
const NARROW: u16 = 90;
const ESC: &str = "\x1b";
const DIR: &str = "~/proj main";
const RESTORED_LABEL: &str = "workspace restored";
const WOKE_LABEL: &str = "woke from hibernation";

fn mark(kind: &str) -> String {
    format!("{ESC}]133;{kind}{ESC}\\")
}

fn prompt_sp(cols: u16) -> String {
    format!(
        "{ESC}[7m%{ESC}[27m{}\r \r",
        " ".repeat(usize::from(cols) - 1)
    )
}

fn right_prompt(clock: &str) -> String {
    format!(
        "{DIR}{ESC}[{}C{ESC}[2m{clock}{ESC}[0m\r\n❯ {}",
        usize::from(WIDE) - DIR.len() - clock.len(),
        mark("B")
    )
}

fn prompt_lines(clock: &str) -> String {
    format!("\r\n{}", right_prompt(clock))
}

fn redraw_prompt(clock: &str) -> String {
    format!("\r{ESC}[1A{ESC}[J{}", right_prompt(clock))
}

fn precmd(exit: Option<i32>) -> String {
    let done = exit.map_or_else(String::new, |code| mark(&format!("D;{code}")));
    format!("{done}{}{}", mark("A"), prompt_sp(WIDE))
}

fn zsh_session() -> String {
    [
        precmd(None),
        prompt_lines("12:40:41"),
        redraw_prompt("12:40:42"),
        "echo MARKER-OUT".to_owned(),
        format!("\r\n{}", mark("C")),
        "MARKER-OUT\r\n".to_owned(),
        precmd(Some(0)),
        prompt_lines("12:41:05"),
        redraw_prompt("12:41:06"),
    ]
    .concat()
}

fn strip_vt(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn screen_text(data: &str, cols: u16, rows: u16) -> Vec<String> {
    let mut term = HeadlessScreen::new(cols, rows, 5000).unwrap();
    term.write_raw(data.as_bytes());
    let total = term.total_rows();
    let mut lines: Vec<String> = if total == 0 {
        Vec::new()
    } else {
        term.serialize(0, total - 1)
            .iter()
            .map(|line| strip_vt(line).trim_end().to_owned())
            .collect()
    };
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    lines
}

fn mirrored(data: &str, cols: u16, rows: u16) -> ScreenMirror {
    let mut mirror = ScreenMirror::new(cols, rows, None).unwrap();
    mirror.write(data);
    mirror
}

fn serialized(data: &str, cols: u16, rows: u16) -> String {
    let mut mirror = mirrored(data, cols, rows);
    let out = mirror.serialize();
    mirror.dispose();
    out
}

fn serialized_wide(data: &str) -> String {
    serialized(data, WIDE, 30)
}

fn lines_wide(data: &str) -> Vec<String> {
    screen_text(data, WIDE, 30)
}

mod screen_mirror_cases {
    use super::*;

    #[test]
    fn garbles_when_the_raw_zsh_stream_is_replayed_at_another_width() {
        let lines = screen_text(&zsh_session(), NARROW, 30);
        assert!(lines.iter().any(|line| line.trim() == "%"), "{lines:?}");
    }

    #[test]
    fn serializes_a_p10k_session_into_history_that_replays_cleanly_at_a_narrower_width() {
        let lines = screen_text(&serialized_wide(&zsh_session()), NARROW, 30);
        assert!(!lines.iter().any(|line| line.contains('%')), "{lines:?}");
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("MARKER-OUT"))
                .count(),
            2
        );
        assert_eq!(lines.iter().filter(|line| line.contains(DIR)).count(), 1);
        let text = lines.join("\n");
        assert!(!text.contains("12:40:41"));
        assert!(!text.contains("12:41"));
    }

    #[test]
    fn keeps_a_right_aligned_clock_whole_at_narrower_and_wider_widths() {
        let history = serialized_wide(&zsh_session());
        let clock = Regex::new(r"[0-9]:[0-9]").unwrap();
        for cols in [NARROW, WIDE, 200] {
            let clock_lines: Vec<String> = screen_text(&history, cols, 30)
                .into_iter()
                .filter(|line| clock.is_match(line))
                .collect();
            assert_eq!(clock_lines.len(), 1, "cols {cols}");
            assert!(clock_lines[0].contains("12:40:42"), "cols {cols}");
        }
    }

    #[test]
    fn lays_history_out_exactly_as_the_original_screen_at_the_original_width() {
        let history = serialized_wide(&zsh_session());
        assert_eq!(
            lines_wide(&history),
            vec![
                format!(
                    "{DIR}{}12:40:42",
                    " ".repeat(usize::from(WIDE) - DIR.len() - 8)
                ),
                "❯ echo MARKER-OUT".to_owned(),
                "MARKER-OUT".to_owned(),
            ]
        );
    }

    #[test]
    fn emits_no_cursor_movement_only_text_and_sgr() {
        let history = serialized_wide(&zsh_session());
        let control = Regex::new("\x1b\\[[0-9;]*[A-Za-z]").unwrap();
        let controls: Vec<&str> = control.find_iter(&history).map(|m| m.as_str()).collect();
        assert!(!controls.is_empty());
        assert!(controls.iter().all(|c| c.ends_with('m')), "{controls:?}");
        assert!(!history.contains(&format!("{ESC}]")));
    }

    #[test]
    fn keeps_colors_and_ends_with_an_sgr_reset() {
        let history = serialized_wide(&format!("{ESC}[31mred{ESC}[0m plain {ESC}[38;2;1;2;3mrgb"));
        assert_eq!(
            history,
            format!("{ESC}[0m{ESC}[38;5;1mred{ESC}[0m plain {ESC}[0m{ESC}[38;2;1;2;3mrgb{ESC}[0m")
        );
    }

    #[test]
    fn joins_soft_wrapped_rows_into_one_line_that_rewraps_at_the_new_width() {
        let history = serialized(&format!("{}\r\nnext", "x".repeat(50)), 20, 10);
        assert_eq!(history, format!("{}\r\nnext", "x".repeat(50)));
    }

    #[test]
    fn keeps_the_whole_screen_while_a_command_is_still_running() {
        let history = serialized_wide(&format!(
            "{}{}sleep 5\r\n{}working",
            precmd(None),
            prompt_lines("09:00:00"),
            mark("C")
        ));
        let lines = lines_wide(&history);
        assert_eq!(lines.last().unwrap(), "working");
        assert!(lines.iter().any(|line| line.starts_with("❯ sleep 5")));
    }

    #[test]
    fn keeps_output_that_lacks_a_trailing_newline() {
        let history = serialized_wide(&format!("{}partial{}", mark("C"), precmd(Some(0))));
        let lines = lines_wide(&history);
        assert!(lines[0].starts_with("partial"), "{lines:?}");
    }

    #[test]
    fn keeps_everything_when_the_shell_has_no_integration_marks() {
        let lines = lines_wide(&serialized_wide("one\r\ntwo\r\n$ "));
        assert_eq!(lines, vec!["one", "two", "$"]);
    }

    #[test]
    fn bounds_the_serialized_history() {
        let out = (0..HISTORY_LINES + 200)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\r\n");
        let lines = screen_text(&serialized(&out, 40, 10), 40, 30);
        assert_eq!(lines.len(), HISTORY_LINES);
        assert_eq!(
            lines.last().unwrap(),
            &format!("line {}", HISTORY_LINES + 199)
        );
    }

    #[test]
    fn applies_resizes_in_order_with_the_bytes_written_before_them() {
        let mut mirror = ScreenMirror::new(80, 10, None).unwrap();
        mirror.write(&format!("{ESC}[70GX\r\n"));
        mirror.resize(40, 10);
        assert_eq!((mirror.cols(), mirror.rows()), (40, 10));
        mirror.resize(0, 0);
        assert_eq!((mirror.cols(), mirror.rows()), (40, 10));
        let history = mirror.serialize();
        mirror.dispose();
        assert_eq!(history, format!("{}X", " ".repeat(69)));
    }

    #[test]
    fn walks_the_buffer_again_only_after_the_screen_changed() {
        let mut mirror = mirrored("FIRST-OUT\r\n", WIDE, 30);
        let first = mirror.serialize();
        let walked = mirror.history_walks();
        assert!(walked > 0);
        assert_eq!(mirror.serialize(), first);
        assert_eq!(mirror.history_walks(), walked);
        mirror.write("MORE-OUT\r\n");
        assert!(mirror.serialize().contains("MORE-OUT"));
        assert!(mirror.history_walks() > walked);
        mirror.dispose();
    }

    #[test]
    fn moves_its_revision_on_parsed_output_a_resize_and_a_restore_never_on_a_read() {
        let mut mirror = mirrored("out\r\n", 80, 10);
        let mut seen = vec![mirror.revision()];
        mirror.serialize();
        seen.push(mirror.revision());
        mirror.resize(40, 10);
        seen.push(mirror.revision());
        mirror.restore("old");
        seen.push(mirror.revision());
        mirror.dispose();
        assert_eq!(seen[1], seen[0]);
        assert!(seen[2] > seen[1], "{seen:?}");
        assert!(seen[3] > seen[2], "{seen:?}");
    }

    #[test]
    fn ignores_writes_and_serializes_nothing_once_disposed() {
        let mut mirror = mirrored("before", WIDE, 30);
        mirror.dispose();
        mirror.write("after");
        assert_eq!(mirror.serialize(), "");
        assert_eq!(mirror.screen_text(10), "");
    }

    #[test]
    fn raises_a_size_below_one_to_one() {
        let mirror = ScreenMirror::new(0, 0, None).unwrap();
        assert_eq!((mirror.cols(), mirror.rows()), (1, 1));
    }

    #[test]
    fn keeps_the_history_from_before_a_full_screen_program_while_it_is_on_the_alternate_screen() {
        let normal = "one\r\ntwo\r\n$ ";
        let expected = serialized(normal, 40, 10);
        let mut mirror = mirrored(normal, 40, 10);
        mirror.write(&format!("{ESC}[?1049h{ESC}[Hfull screen app"));
        let history = mirror.serialize();
        mirror.dispose();
        assert_eq!(history, expected);
        assert!(!history.contains("full screen app"));
    }

    #[test]
    fn has_no_block_end_and_no_tail_without_a_history_feed() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let mirror = mirrored("out\r\n", WIDE, 30);
        assert!(rt.block_on(mirror.pending_block_end(0)).is_none());
        assert_eq!(rt.block_on(mirror.history_tail()), Vec::<String>::new());
        assert_eq!(mirror.block_seq_base(), 0);
    }

    #[test]
    fn builds_the_seam_lines_from_the_banner_labels() {
        assert_eq!(
            restore_seam(RESTORED_LABEL),
            format!("{ESC}]133;D\x07\r\n{ESC}[2m── {RESTORED_LABEL} ──{ESC}[0m\r\n")
        );
        assert_eq!(
            hibernate_seam(WOKE_LABEL),
            format!("{ESC}]133;D\x07\r\n{ESC}[2m── {WOKE_LABEL} ──{ESC}[0m\r\n")
        );
    }
}

mod screen_mirror_screen_text_cases {
    use super::*;

    #[test]
    fn mgr_c31_returns_the_last_lines_of_the_active_screen_as_plain_text_joining_wrapped_rows() {
        let mut mirror = ScreenMirror::new(10, 5, None).unwrap();
        mirror.write(&format!(
            "{ESC}[31mred{ESC}[0m line\r\n0123456789abc\r\nlast\r\n"
        ));
        assert_eq!(mirror.screen_text(10), "red line\n0123456789abc\nlast");
        assert_eq!(mirror.screen_text(1), "last");
        assert_eq!(mirror.screen_text(0), "");
        mirror.dispose();
    }

    #[test]
    fn mgr_c31_reads_a_full_screen_program_on_the_alternate_screen() {
        let mut mirror = ScreenMirror::new(20, 3, None).unwrap();
        mirror.write("shell history\r\n");
        mirror.write(&format!("{ESC}[?1049h{ESC}[Happroval? [y/n]"));
        assert_eq!(mirror.screen_text(50), "approval? [y/n]");
        mirror.dispose();
    }
}

mod screen_mirror_bracketed_paste_cases {
    use super::*;

    #[test]
    fn follows_the_program_turning_bracketed_paste_on_and_off() {
        let mut mirror = ScreenMirror::new(80, 24, None).unwrap();
        assert!(!mirror.bracketed_paste());
        mirror.write(&format!("{ESC}[?2004h"));
        assert!(mirror.bracketed_paste());
        mirror.write(&format!("{ESC}[?2004l"));
        assert!(!mirror.bracketed_paste());
        mirror.write(&format!("{ESC}[?2004h"));
        mirror.dispose();
        assert!(!mirror.bracketed_paste());
    }
}

fn restored_run(history: &str, after: &str) -> String {
    let mut mirror = ScreenMirror::new(WIDE, 30, None).unwrap();
    mirror.restore(history);
    mirror.write(after);
    let saved = mirror.serialize();
    mirror.dispose();
    saved
}

fn seams(text: &str) -> usize {
    text.matches(RESTORED_LABEL).count() + text.matches(WOKE_LABEL).count()
}

fn shown(saved: &str, seam: &str) -> String {
    format!("{saved}{seam}")
}

fn fresh_prompt(clock: &str) -> String {
    format!("{}{}", precmd(None), prompt_lines(clock))
}

fn ran_command(clock: &str, command: &str, output: &str) -> String {
    format!(
        "{}{command}\r\n{}{output}\r\n{}{}",
        fresh_prompt(clock),
        mark("C"),
        precmd(Some(0)),
        prompt_lines(clock)
    )
}

mod screen_mirror_restored_history_cases {
    use super::*;

    #[test]
    fn saves_the_restored_history_unchanged_while_no_command_ran_restart_after_restart() {
        let history = serialized_wide(&zsh_session());
        let first = restored_run(&history, &fresh_prompt("13:00:00"));
        let second = restored_run(&first, &fresh_prompt("13:05:00"));
        assert_eq!(first, history);
        assert_eq!(second, history);
        assert_eq!(seams(&second), 0);
    }

    #[test]
    fn saves_no_seam_so_a_command_after_the_restore_follows_the_earlier_output_directly() {
        let history = serialized_wide(&zsh_session());
        let used = restored_run(&history, &ran_command("13:00:00", "ls", "LS-OUT"));
        let idle = restored_run(&used, &fresh_prompt("13:05:00"));
        assert_eq!(idle, used);
        assert_eq!(seams(&idle), 0);
        let lines = lines_wide(&idle);
        let position = |text: &str| lines.iter().position(|line| line == text).unwrap();
        assert!(position("LS-OUT") > position("MARKER-OUT"), "{lines:?}");
    }

    #[test]
    fn rsm_c1_shows_one_seam_and_each_command_once_after_three_restarts_that_each_ran_a_command() {
        let mut saved = serialized_wide(&zsh_session());
        let commands = ["'claude' --resume dead-1", "ls", "pwd"];
        for (i, command) in commands.iter().enumerate() {
            saved = restored_run(
                &saved,
                &ran_command(&format!("13:0{i}:00"), command, &format!("OUT-{i}")),
            );
        }
        let lines = lines_wide(&shown(&saved, &restore_seam(RESTORED_LABEL)));
        assert_eq!(seams(&lines.join("\n")), 1);
        for command in commands {
            assert_eq!(
                lines.iter().filter(|line| line.ends_with(command)).count(),
                1,
                "{command}"
            );
        }
    }

    #[test]
    fn saves_the_restored_history_unchanged_when_the_shell_prints_before_its_first_prompt() {
        let history = serialized_wide(&zsh_session());
        let greeting = "To run a command as administrator, use \"sudo <command>\".\r\n";
        let first = restored_run(&history, &format!("{greeting}{}", fresh_prompt("13:00:00")));
        let second = restored_run(&first, &format!("{greeting}{}", fresh_prompt("13:05:00")));
        assert_eq!(first, history);
        assert_eq!(second, history);
    }

    #[test]
    fn does_the_same_for_a_pane_woken_from_hibernation_and_shows_one_wake_seam() {
        let history = serialized_wide(&zsh_session());
        let asleep = restored_run(&history, &fresh_prompt("13:00:00"));
        assert_eq!(asleep, history);
        let used = restored_run(&asleep, &ran_command("13:05:00", "ls", "LS-OUT"));
        let again = restored_run(&used, &ran_command("13:10:00", "ls", "LS-OUT"));
        assert_eq!(seams(&again), 0);
        let lines = lines_wide(&shown(&again, &hibernate_seam(WOKE_LABEL)));
        assert_eq!(seams(&lines.join("\n")), 1);
    }

    #[test]
    fn saves_the_whole_screen_once_a_shell_without_marks_prints_past_the_restore() {
        let saved = restored_run("old", "new output\r\n$ ");
        assert_eq!(lines_wide(&saved), vec!["old", "new output", "$"]);
    }
}

mod screen_mirror_cwd_report_cases {
    use super::*;

    #[test]
    fn keeps_the_last_folder_the_pane_itself_reported_and_ignores_a_malformed_report() {
        let mut mirror = ScreenMirror::new(80, 24, None).unwrap();
        assert_eq!(mirror.cwd_report(), None);
        mirror.write("\x1b]7;file://box/home/u/proj\x07");
        mirror.write("\x1b]7;nonsense\x07");
        assert_eq!(
            mirror.cwd_report(),
            Some(CwdReport {
                host: "box".to_owned(),
                path: "/home/u/proj".to_owned(),
            })
        );
        mirror.dispose();
    }
}

struct QuietPort;

impl SpillPort for QuietPort {
    fn post_message(&self, _request: SpillRequest) -> Result<(), String> {
        Ok(())
    }

    fn on_message(&self, _listener: Arc<dyn Fn(SpillEvent) + Send + Sync>) {}
}

#[tokio::test]
async fn walks_the_buffer_for_no_write_or_resize_while_a_history_feed_is_attached() {
    let client = SpillClient::new(Arc::new(QuietPort));
    let made = make_history(HistoryOptions::default());
    let feed = client.open(&made.history, WIDE, 30, None);
    let mut mirror = ScreenMirror::new(WIDE, 30, Some(feed)).unwrap();
    for index in 0..200 {
        mirror.write(&format!("line {index}\r\n"));
    }
    mirror.resize(100, 30);
    mirror.restore("old history");
    assert_eq!(mirror.history_walks(), 0);
    assert!(mirror.serialize().contains("line 199"));
    assert_eq!(mirror.history_walks(), 1);
    mirror.dispose();
}
