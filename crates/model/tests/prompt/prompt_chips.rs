use chrono::{NaiveDate, NaiveDateTime};
use ostia_contract::extensions::SidebarTone;
use ostia_contract::prompt_settings::{PromptSettings, PromptStyle};
use ostia_contract::pty_api::{
    OstiaPromptSpawn, PromptContext, PromptContextRequest, PromptSeparator,
};
use ostia_model::prompt::prompt_chips::{
    ChipTone, CoreChipInputs, LastCommand, ShownChip, abbreviate_home, add_chip, context_request,
    format_duration, last_command, move_chip, needs_clock, prompt_line, remove_chip,
    resolve_prompt_chips, spawn_prompt_option,
};
use ostia_model::terminal::blocks_store::{CommandBlock, LineAnchor};
use regex::Regex;

fn shown(id: &str, text: &str, tone: SidebarTone) -> ShownChip {
    ShownChip::new("git", id, text, tone)
}

fn context() -> PromptContext {
    PromptContext {
        user: "ada".to_owned(),
        host: "box".to_owned(),
        home: "/home/ada".to_owned(),
        virtual_env: Some(".venv".to_owned()),
        conda_env: None,
        node_version: Some("v20.1.0".to_owned()),
        kube_context: None,
    }
}

fn now() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 9, 30)
        .unwrap()
        .and_hms_opt(14, 5, 0)
        .unwrap()
}

fn inputs() -> CoreChipInputs {
    CoreChipInputs {
        cwd: Some("/home/ada/proj".to_owned()),
        context: Some(context()),
        last_command: None,
        now: now(),
        locale: "en".to_owned(),
    }
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| (*id).to_owned()).collect()
}

fn block(patch: impl FnOnce(&mut CommandBlock)) -> CommandBlock {
    let mut block = CommandBlock {
        id: "b".to_owned(),
        pane_id: "p".to_owned(),
        prompt_line: LineAnchor::at(0),
        input_line: None,
        output_start_line: LineAnchor::at(0),
        end_line: None,
        end_col: 0,
        command: "ls".to_owned(),
        typed_command: None,
        exit_code: None,
        cwd: None,
        started_at: 0,
        ended_at: None,
        seq: None,
    };
    patch(&mut block);
    block
}

fn finished(exit_code: i64, started_at: i64, ended_at: i64) -> CommandBlock {
    block(|b| {
        b.exit_code = Some(exit_code);
        b.started_at = started_at;
        b.ended_at = Some(ended_at);
    })
}

#[test]
fn shortens_the_home_directory_to_a_tilde_only_on_a_path_boundary() {
    assert_eq!(abbreviate_home("/home/ada", Some("/home/ada")), "~");
    assert_eq!(
        abbreviate_home("/home/ada/proj", Some("/home/ada/")),
        "~/proj"
    );
    assert_eq!(
        abbreviate_home("/home/adam/x", Some("/home/ada")),
        "/home/adam/x"
    );
    assert_eq!(abbreviate_home("/etc", None), "/etc");
    assert_eq!(abbreviate_home("/etc", Some("/")), "/etc");
    assert_eq!(abbreviate_home("/etc", Some("")), "/etc");
}

#[test]
fn reads_like_warps_ms_seconds_then_minutes_and_hours() {
    let table = [
        (340, "340ms"),
        (1500, "1.5s"),
        (12_000, "12s"),
        (125_000, "2m 5s"),
        (3_725_000, "1h 2m"),
        (-5, "0ms"),
    ];
    for (ms, text) in table {
        assert_eq!(format_duration(ms), text, "{ms}");
    }
}

#[test]
fn takes_the_newest_finished_block_and_skips_one_still_running() {
    let blocks = [
        finished(0, 1, 2),
        finished(2, 10, 40),
        block(|b| b.started_at = 50),
    ];
    assert_eq!(
        last_command(Some(&blocks)),
        Some(LastCommand {
            exit_code: 2,
            started_at: 10,
            ended_at: 40
        })
    );
    assert_eq!(last_command(Some(&[block(|_| {})])), None);
    assert_eq!(last_command(None), None);
}

#[test]
fn follows_the_order_and_hides_chips_without_a_value() {
    let order = ids(&[
        "kube",
        "cwd",
        "virtualenv",
        "conda",
        "node",
        "user",
        "host",
        "exitCode",
    ]);
    let chips = resolve_prompt_chips(&order, &inputs(), &[]);
    let seen: Vec<(&str, &str)> = chips
        .iter()
        .map(|c| (c.id.as_str(), c.text.as_str()))
        .collect();
    assert_eq!(
        seen,
        [
            ("cwd", "~/proj"),
            ("virtualenv", ".venv"),
            ("node", "v20.1.0"),
            ("user", "ada"),
            ("host", "box"),
        ]
    );
    assert_eq!(chips[0].tooltip.as_deref(), Some("/home/ada/proj"));
}

#[test]
fn shows_nothing_from_the_main_process_before_its_context_arrives() {
    let without_context = CoreChipInputs {
        context: None,
        ..inputs()
    };
    let chips = resolve_prompt_chips(&ids(&["user", "cwd"]), &without_context, &[]);
    assert_eq!(
        chips.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["cwd"]
    );
    assert_eq!(chips[0].text, "/home/ada/proj");
}

#[test]
fn colors_the_exit_code_by_success_and_shows_the_last_duration() {
    let ok_inputs = CoreChipInputs {
        last_command: Some(LastCommand {
            exit_code: 0,
            started_at: 0,
            ended_at: 2500,
        }),
        ..inputs()
    };
    let ok = resolve_prompt_chips(&ids(&["exitCode", "duration"]), &ok_inputs, &[]);
    let seen: Vec<(&str, ChipTone)> = ok.iter().map(|c| (c.text.as_str(), c.tone)).collect();
    assert_eq!(seen, [("0", ChipTone::Ok), ("2.5s", ChipTone::Default)]);
    let failed_inputs = CoreChipInputs {
        last_command: Some(LastCommand {
            exit_code: 127,
            started_at: 0,
            ended_at: 1,
        }),
        ..inputs()
    };
    let failed = resolve_prompt_chips(&ids(&["exitCode"]), &failed_inputs, &[]);
    assert_eq!(failed[0].text, "127");
    assert_eq!(failed[0].tone, ChipTone::Error);
}

#[test]
fn formats_the_date_and_both_clocks_in_the_ui_locale() {
    let chips = resolve_prompt_chips(&ids(&["time12", "time24", "date"]), &inputs(), &[]);
    assert!(Regex::new(r"^02:05\sPM$").unwrap().is_match(&chips[0].text));
    assert_eq!(chips[1].text, "14:05");
    assert!(chips[2].text.contains("2026"));
}

#[test]
fn formats_the_date_and_the_twelve_hour_clock_with_the_locale_it_is_given() {
    let mut german = inputs();
    german.locale = "de".to_owned();
    let chips = resolve_prompt_chips(&ids(&["date", "time12", "time24"]), &german, &[]);
    assert_eq!(chips[0].text, "Mi., 30. Sept. 2026");
    assert_eq!(chips[1].text, "02:05 PM");
    assert_eq!(chips[2].text, "14:05");
    let mut japanese = inputs();
    japanese.locale = "ja".to_owned();
    let chips = resolve_prompt_chips(&ids(&["time12"]), &japanese, &[]);
    assert_eq!(chips[0].text, "午後02:05");
}

#[test]
fn places_an_extension_chip_by_its_extension_chip_id_when_it_has_a_value() {
    let mut branch = shown("branch", "main", SidebarTone::Ok);
    branch.command = Some("branches".to_owned());
    let contributed = [
        branch,
        shown("stats", "", SidebarTone::Neutral),
        ShownChip::new("other", "host", "nope", SidebarTone::Neutral),
    ];
    let chips = resolve_prompt_chips(
        &ids(&["git.branch", "cwd", "git.stats", "ssh.host"]),
        &inputs(),
        &contributed,
    );
    let seen: Vec<(&str, &str, ChipTone)> = chips
        .iter()
        .map(|c| (c.id.as_str(), c.text.as_str(), c.tone))
        .collect();
    assert_eq!(
        seen,
        [
            ("git.branch", "main", ChipTone::Ok),
            ("cwd", "~/proj", ChipTone::Default),
        ]
    );
    assert_eq!(
        chips[0].extension.as_ref().unwrap().command.as_deref(),
        Some("branches")
    );
}

#[test]
fn shows_neutral_and_brand_pane_chip_tones_as_the_default_chip_tone() {
    let contributed = [
        shown("branch", "main", SidebarTone::Neutral),
        shown("dirty", "+3", SidebarTone::Brand),
    ];
    let chips = resolve_prompt_chips(&ids(&["git.branch", "git.dirty"]), &inputs(), &contributed);
    let tones: Vec<ChipTone> = chips.iter().map(|c| c.tone).collect();
    assert_eq!(tones, [ChipTone::Default, ChipTone::Default]);
}

#[test]
fn keeps_warn_and_error_pane_chip_tones_and_the_tooltip() {
    let mut warn = shown("branch", "main", SidebarTone::Warn);
    warn.tooltip = Some("detached".to_owned());
    let contributed = [warn, shown("dirty", "+3", SidebarTone::Error)];
    let chips = resolve_prompt_chips(&ids(&["git.branch", "git.dirty"]), &inputs(), &contributed);
    assert_eq!(chips[0].tone, ChipTone::Warn);
    assert_eq!(chips[0].tooltip.as_deref(), Some("detached"));
    assert_eq!(chips[1].tone, ChipTone::Error);
    assert_eq!(chips[1].tooltip, None);
    assert_eq!(chips[0].core, None);
}

#[test]
fn asks_main_for_node_and_kube_only_when_those_chips_are_in_the_prompt() {
    assert_eq!(
        context_request(&ids(&["cwd"])),
        PromptContextRequest {
            node: false,
            kube: false
        }
    );
    assert_eq!(
        context_request(&ids(&["kube", "node"])),
        PromptContextRequest {
            node: true,
            kube: true
        }
    );
    assert!(!needs_clock(&ids(&["cwd", "exitCode"])));
    assert!(needs_clock(&ids(&["time24"])));
}

#[test]
fn joins_the_chip_texts_and_the_separator_for_copying() {
    let chips = resolve_prompt_chips(&ids(&["user", "cwd"]), &inputs(), &[]);
    assert_eq!(prompt_line(&chips, PromptSeparator::Dollar), "ada ~/proj $");
    assert_eq!(prompt_line(&chips, PromptSeparator::None), "ada ~/proj");
}

#[test]
fn reorders_without_losing_or_duplicating_a_chip() {
    let order = ids(&["a", "b", "c", "d"]);
    assert_eq!(move_chip(&order, 0, 2), ids(&["b", "c", "a", "d"]));
    assert_eq!(move_chip(&order, 3, 0), ids(&["d", "a", "b", "c"]));
    assert_eq!(move_chip(&order, 1, 99), ids(&["a", "c", "d", "b"]));
    assert_eq!(move_chip(&order, 9, 0), order);
    assert_eq!(add_chip(&order, "b"), order);
    assert_eq!(add_chip(&order, "e"), ids(&["a", "b", "c", "d", "e"]));
    assert_eq!(remove_chip(&order, "c"), ids(&["a", "b", "d"]));
}

#[test]
fn keeps_the_order_when_a_chip_moves_to_its_own_place_or_from_below_zero() {
    let order = ids(&["a", "b", "c"]);
    assert_eq!(move_chip(&order, 1, 1), order);
    assert_eq!(move_chip(&order, -1, 0), order);
    assert_eq!(move_chip(&order, 0, -4), order);
}

fn settings(style: PromptStyle) -> PromptSettings {
    PromptSettings {
        style,
        separator: PromptSeparator::Greater,
        ..PromptSettings::default()
    }
}

#[test]
fn asks_for_the_plain_shell_prompt_only_for_the_ostia_prompt_in_the_input_editor() {
    assert_eq!(
        spawn_prompt_option("editor", &settings(PromptStyle::Ostia)),
        Some(OstiaPromptSpawn {
            separator: PromptSeparator::Greater,
            same_line: PromptSettings::default().same_line,
        })
    );
    assert_eq!(
        spawn_prompt_option("terminal", &settings(PromptStyle::Ostia)),
        None
    );
    assert_eq!(
        spawn_prompt_option("editor", &settings(PromptStyle::Shell)),
        None
    );
}
