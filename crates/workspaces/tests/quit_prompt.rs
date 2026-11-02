#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::VecDeque;
use std::sync::Arc;

use ostia_contract::dict::{Dict, en, zh_hant};
use ostia_contract::windows_api::{QuitAnswer, RunningGroup};
use ostia_workspaces::quit_prompt::{
    MAX_GROUPS, MAX_ITEMS_PER_GROUP, MAX_NAME_COLUMNS, MessageBoxOptions, MessageDialog,
    capped_lost_lines, native_quit_confirm, quit_prompt_options,
};
use parking_lot::Mutex;
use serde_json::Value;

fn en_text() -> &'static Value {
    &en()["native"]["quit"]
}

fn zh_text() -> &'static Value {
    &zh_hant()["native"]["quit"]
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).to_owned()).collect()
}

fn groups() -> Vec<RunningGroup> {
    vec![
        RunningGroup {
            workspace_id: "w1".to_owned(),
            workspace: "api".to_owned(),
            commands: strings(&["make", ""]),
            agents: strings(&["claude"]),
            files: strings(&["/w/notes.md"]),
            scratch_files: 2,
            unanswered: false,
        },
        RunningGroup {
            workspace_id: "w2".to_owned(),
            workspace: "web".to_owned(),
            unanswered: true,
            ..RunningGroup::default()
        },
    ]
}

fn many_commands(count: usize) -> Vec<String> {
    (1..=count).map(|i| format!("job-{i}")).collect()
}

fn group_of(index: usize, commands: Vec<String>) -> RunningGroup {
    RunningGroup {
        workspace_id: format!("w{index}"),
        workspace: format!("ws-{index}"),
        commands,
        ..RunningGroup::default()
    }
}

fn detail_lines(options: &MessageBoxOptions) -> Vec<&str> {
    options.detail.split('\n').collect()
}

fn width(text: &str) -> usize {
    text.chars().count()
}

#[test]
fn lists_what_each_workspace_loses_and_defaults_to_cancel() {
    let options = quit_prompt_options(&groups(), 0, en_text());
    assert_eq!(options.buttons, ["Cancel", "Quit"]);
    assert_eq!(options.cancel_id, 0);
    assert_eq!(options.default_id, 0);
    assert_eq!(
        detail_lines(&options),
        [
            "Quitting ends or discards everything listed here.",
            "",
            "api",
            "  Running: make",
            "  Running: a command",
            "  Agent: claude",
            "  Unsaved: notes.md",
            "  Files in the scratch folder: 2",
            "web",
            "  The window did not answer, so it may have running commands or unsaved files",
        ]
    );
}

#[test]
fn speaks_the_language_of_the_catalog_it_is_given() {
    assert_eq!(
        quit_prompt_options(&groups(), 0, zh_text()).buttons,
        ["取消", "結束"]
    );
}

#[test]
fn leaves_a_group_at_or_under_the_item_cap_unchanged() {
    let under = capped_lost_lines(
        en_text(),
        &[group_of(1, many_commands(MAX_ITEMS_PER_GROUP - 1))],
    );
    assert_eq!(under.len(), MAX_ITEMS_PER_GROUP);
    assert!(!under.iter().any(|line| line.contains("more")));
    let exact = capped_lost_lines(
        en_text(),
        &[group_of(1, many_commands(MAX_ITEMS_PER_GROUP))],
    );
    assert_eq!(exact.len(), MAX_ITEMS_PER_GROUP + 1);
    assert_eq!(
        exact.last().unwrap(),
        &format!("  Running: job-{MAX_ITEMS_PER_GROUP}")
    );
}

#[test]
fn shows_the_first_items_of_a_group_and_counts_the_rest() {
    let lines = capped_lost_lines(
        en_text(),
        &[group_of(1, many_commands(MAX_ITEMS_PER_GROUP + 7))],
    );
    let mut expected = vec!["ws-1".to_owned()];
    expected.extend(
        many_commands(MAX_ITEMS_PER_GROUP)
            .iter()
            .map(|c| format!("  Running: {c}")),
    );
    expected.push("  and 7 more".to_owned());
    assert_eq!(lines, expected);
}

#[test]
fn counts_commands_agents_files_and_notes_together() {
    let lines = capped_lost_lines(
        en_text(),
        &[RunningGroup {
            workspace_id: "w1".to_owned(),
            workspace: "api".to_owned(),
            commands: many_commands(2),
            agents: strings(&["claude", "codex"]),
            files: strings(&["/w/a.md", "/w/b.md"]),
            scratch_files: 3,
            unanswered: true,
        }],
    );
    assert_eq!(lines.len(), 1 + MAX_ITEMS_PER_GROUP + 1);
    assert_eq!(lines.last().unwrap(), "  and 3 more");
}

#[test]
fn shows_the_first_workspaces_and_counts_the_rest() {
    let many: Vec<_> = (1..=MAX_GROUPS + 5)
        .map(|i| group_of(i, strings(&["make"])))
        .collect();
    let lines = capped_lost_lines(en_text(), &many);
    let shown: Vec<_> = lines.iter().filter(|l| l.starts_with("ws-")).collect();
    let expected: Vec<_> = (1..=MAX_GROUPS).map(|i| format!("ws-{i}")).collect();
    assert_eq!(shown, expected.iter().collect::<Vec<_>>());
    assert_eq!(lines.last().unwrap(), "and 5 more workspaces");
}

#[test]
fn caps_both_levels_at_once_and_speaks_the_chosen_language() {
    let many: Vec<_> = (1..=MAX_GROUPS + 2)
        .map(|i| group_of(i, many_commands(MAX_ITEMS_PER_GROUP + 2)))
        .collect();
    let lines = capped_lost_lines(zh_text(), &many);
    assert_eq!(lines.len(), MAX_GROUPS * (MAX_ITEMS_PER_GROUP + 2) + 1);
    assert_eq!(lines.last().unwrap(), "還有 2 個工作區");
    assert!(lines.contains(&"  還有 2 項".to_owned()));
}

#[test]
fn clips_very_long_names_workspace_names_and_file_names() {
    let long = "x".repeat(500);
    let lines = capped_lost_lines(
        en_text(),
        &[RunningGroup {
            workspace_id: "w1".to_owned(),
            workspace: long.clone(),
            commands: vec![long.clone()],
            agents: vec![long.clone()],
            files: vec![format!("/w/{long}.md")],
            ..RunningGroup::default()
        }],
    );
    assert_eq!(width(&lines[0]), MAX_NAME_COLUMNS);
    assert!(lines[0].ends_with('…'));
    for line in &lines[1..] {
        assert!(width(line) < MAX_NAME_COLUMNS + 20, "{line}");
    }
}

#[test]
fn folds_a_multi_line_command_into_one_line() {
    let lines = capped_lost_lines(
        en_text(),
        &[group_of(
            1,
            strings(&["cat <<EOF\n  line one\r\n\tline two\nEOF", " \n\t "]),
        )],
    );
    assert_eq!(
        lines,
        [
            "ws-1",
            "  Running: cat <<EOF line one line two EOF",
            "  Running: a command",
        ]
    );
}

#[test]
fn clips_by_display_width_so_wide_characters_cannot_widen_the_alert() {
    let lines = capped_lost_lines(en_text(), &[group_of(1, vec!["漢".repeat(100)])]);
    let name = lines[1].replace("  Running: ", "");
    assert!(name.ends_with('…'));
    assert_eq!(width(&name), MAX_NAME_COLUMNS / 2);
    assert!(width(&lines[1]) < MAX_NAME_COLUMNS);
}

#[test]
fn never_cuts_an_emoji_in_half_at_the_clip_point() {
    let first = format!("{}😀😀", "a".repeat(MAX_NAME_COLUMNS - 2));
    let second = format!("{}😀😀", "a".repeat(MAX_NAME_COLUMNS - 3));
    let lines = capped_lost_lines(en_text(), &[group_of(1, vec![first, second])]);
    assert_eq!(
        lines[1],
        format!("  Running: {}…", "a".repeat(MAX_NAME_COLUMNS - 2))
    );
    assert_eq!(
        lines[2],
        format!("  Running: {}😀…", "a".repeat(MAX_NAME_COLUMNS - 3))
    );
}

#[test]
fn counts_symbols_and_flags_as_wide_when_clipping() {
    let cup = format!("{}☕", "a".repeat(MAX_NAME_COLUMNS - 1));
    let flag = format!("{}🇯🇵", "a".repeat(MAX_NAME_COLUMNS - 1));
    let lines = capped_lost_lines(en_text(), &[group_of(1, vec![cup, flag])]);
    let clipped = format!("  Running: {}…", "a".repeat(MAX_NAME_COLUMNS - 1));
    assert_eq!(lines[1..], [clipped.clone(), clipped]);
}

#[test]
fn keeps_a_name_that_exactly_fits() {
    let fits = "a".repeat(MAX_NAME_COLUMNS);
    assert_eq!(
        capped_lost_lines(en_text(), &[group_of(1, vec![fits.clone()])])[1],
        format!("  Running: {fits}")
    );
}

#[test]
fn shows_every_item_when_only_one_would_be_hidden() {
    let lines = capped_lost_lines(
        en_text(),
        &[group_of(1, many_commands(MAX_ITEMS_PER_GROUP + 1))],
    );
    assert_eq!(lines.len(), MAX_ITEMS_PER_GROUP + 2);
    assert!(!lines.iter().any(|line| line.contains("more")));
}

#[test]
fn uses_the_singular_when_one_workspace_is_hidden() {
    let many: Vec<_> = (1..=MAX_GROUPS + 1)
        .map(|i| group_of(i, strings(&["make"])))
        .collect();
    assert_eq!(
        capped_lost_lines(en_text(), &many).last().unwrap(),
        "and 1 more workspace"
    );
    assert_eq!(
        capped_lost_lines(zh_text(), &many).last().unwrap(),
        "還有 1 個工作區"
    );
}

#[test]
fn keeps_the_detail_short_for_60_panes_across_12_workspaces() {
    let many: Vec<_> = (1..=12).map(|i| group_of(i, many_commands(8))).collect();
    let options = quit_prompt_options(&many, 3, en_text());
    let lines = detail_lines(&options);
    assert!(lines.len() <= 30);
    assert!(lines.contains(&"and 9 more workspaces"));
    assert!(lines.contains(&"  and 3 more"));
    assert_eq!(
        options.buttons,
        ["Cancel", "Quit and end shells", "Quit and keep shells"]
    );
    assert_eq!(options.default_id, 2);
    assert_eq!(options.cancel_id, 0);
}

#[test]
fn keeps_the_detail_short_for_60_panes_in_one_workspace() {
    let options = quit_prompt_options(&[group_of(1, many_commands(60))], 0, en_text());
    let lines = detail_lines(&options);
    assert!(lines.len() <= 10);
    assert_eq!(lines.last().unwrap(), &"  and 55 more");
}

#[test]
fn ksh_c100_says_the_kept_shells_end_on_quit_and_defaults_to_keeping_them() {
    let options = quit_prompt_options(&[], 2, en_text());
    assert_eq!(options.message, "Quit with kept shells running?");
    assert_eq!(
        options.buttons,
        ["Cancel", "Quit and end shells", "Quit and keep shells"]
    );
    assert_eq!(options.cancel_id, 0);
    assert_eq!(options.default_id, 2);
    assert_eq!(
        detail_lines(&options),
        [
            "2 kept shells are running",
            "Quit and keep shells leaves them running in tmux, and the next start reattaches them. Quit and end shells ends them.",
        ]
    );
}

#[test]
fn lists_what_the_quit_loses_above_the_kept_shells() {
    let options = quit_prompt_options(&groups()[1..], 1, en_text());
    assert_eq!(options.message, "Quit and lose this work?");
    assert_eq!(
        detail_lines(&options),
        [
            "Quitting ends or discards everything listed here.",
            "",
            "web",
            "  The window did not answer, so it may have running commands or unsaved files",
            "",
            "1 kept shell is running",
            "Quit and keep shells leaves them running in tmux, and the next start reattaches them. Quit and end shells ends them.",
        ]
    );
}

#[test]
fn asks_with_a_warning_dialog_that_has_no_link_buttons() {
    let options = quit_prompt_options(&groups(), 0, en_text());
    assert_eq!(options.title, "Quit and lose this work?");
    assert_eq!(options.message, "Quit and lose this work?");
    assert!(options.no_link);
}

#[test]
fn titles_the_prompt_for_kept_shells_only_when_nothing_else_is_lost() {
    let only_kept = quit_prompt_options(&[], 1, en_text());
    assert_eq!(only_kept.title, "Quit with kept shells running?");
    let both = quit_prompt_options(&groups(), 1, en_text());
    assert_eq!(both.title, "Quit and lose this work?");
    assert_eq!(both.default_id, 2);
}

#[test]
fn falls_back_to_the_whole_path_when_the_file_name_is_empty() {
    let lines = capped_lost_lines(
        en_text(),
        &[RunningGroup {
            workspace_id: "w1".to_owned(),
            workspace: "api".to_owned(),
            files: strings(&["/w/dir/"]),
            ..RunningGroup::default()
        }],
    );
    assert_eq!(lines, ["api", "  Unsaved: /w/dir/"]);
}

#[derive(Default)]
struct FakeDialog {
    responses: Mutex<VecDeque<usize>>,
    seen: Mutex<Vec<MessageBoxOptions>>,
}

#[derive(Clone, Default)]
struct SharedDialog(Arc<FakeDialog>);

impl SharedDialog {
    fn answer(&self, response: usize) {
        self.0.responses.lock().push_back(response);
    }
}

impl MessageDialog for SharedDialog {
    async fn show(&self, options: MessageBoxOptions) -> usize {
        self.0.seen.lock().push(options);
        self.0.responses.lock().pop_front().unwrap()
    }
}

#[tokio::test]
async fn quits_only_on_the_quit_button() {
    let dialog = SharedDialog::default();
    let confirm = native_quit_confirm(|| en().clone(), dialog.clone());
    dialog.answer(1);
    assert_eq!(confirm.confirm(&groups(), 0).await, QuitAnswer::Quit);
    dialog.answer(0);
    assert_eq!(confirm.confirm(&groups(), 0).await, QuitAnswer::Cancel);
    dialog.answer(2);
    assert_eq!(confirm.confirm(&groups(), 0).await, QuitAnswer::Cancel);
}

#[tokio::test]
async fn ksh_c101_answers_keep_shells_or_quit_when_kept_shells_are_offered() {
    let dialog = SharedDialog::default();
    let confirm = native_quit_confirm(|| en().clone(), dialog.clone());
    dialog.answer(2);
    assert_eq!(confirm.confirm(&[], 1).await, QuitAnswer::KeepShells);
    dialog.answer(1);
    assert_eq!(confirm.confirm(&[], 1).await, QuitAnswer::Quit);
}

#[tokio::test]
async fn the_main_process_asks_in_the_language_of_the_chosen_pack_the_native_quit_prompt() {
    let catalog: Arc<Mutex<Dict>> = Arc::new(Mutex::new(zh_hant().clone()));
    let reading = Arc::clone(&catalog);
    let dialog = SharedDialog::default();
    let ask = native_quit_confirm(move || reading.lock().clone(), dialog.clone());
    let unanswered = groups()[1..].to_vec();
    dialog.answer(0);
    assert_eq!(ask.confirm(&unanswered, 0).await, QuitAnswer::Cancel);
    let zh = zh_text();
    {
        let seen = dialog.0.seen.lock();
        let last = seen.last().unwrap();
        assert_eq!(last.title, zh["title"].as_str().unwrap());
        assert!(last.detail.contains(zh["unanswered"].as_str().unwrap()));
        assert_eq!(
            last.buttons,
            [
                zh["cancel"].as_str().unwrap().to_owned(),
                zh["quit"].as_str().unwrap().to_owned(),
            ]
        );
    }
    *catalog.lock() = en().clone();
    dialog.answer(0);
    ask.confirm(&unanswered, 0).await;
    let seen = dialog.0.seen.lock();
    assert_eq!(seen.last().unwrap().buttons, ["Cancel", "Quit"]);
}
