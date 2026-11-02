#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use ostia_contract::chord_spec::{
    BROWSER_CHORD_IDS, CHORDS_PER_COMMAND_MAX, ChordProblem, ChordSpec, ChordValue, DIGIT_RANGE,
    DOUBLE_SHIFT, DOUBLE_SHIFT_KEY, DoubleShiftDetector, KeyLike, PALETTE_TOGGLE,
    TERMINAL_CHORD_IDS, TERMINAL_COMMAND_CHORD_IDS, TERMINAL_SCOPE, TapKey, WORKSPACE_GOTO,
    binding_problem, check_binding, chord_text, chord_texts, format_chord, format_scoped_chord,
    is_double_shift, is_double_shift_key, is_native_clipboard_key, is_palette_f1, overlaps,
    parse_chord, parse_keybindings, parse_scoped_chord, same_chord, same_scope, spec_from_event,
    steals_terminal_key, used_by_monaco,
};
use serde_json::{Value, json};

fn chord(text: &str, mac: bool) -> ChordSpec {
    parse_chord(text, mac).unwrap_or_else(|| panic!("unparseable: {text}"))
}

fn event(key: &str, code: &str) -> KeyLike {
    KeyLike {
        key: key.to_owned(),
        code: code.to_owned(),
        ctrl: false,
        meta: false,
        shift: false,
        alt: false,
    }
}

fn shifted_ctrl(key: &str, code: &str) -> KeyLike {
    KeyLike {
        ctrl: true,
        shift: true,
        ..event(key, code)
    }
}

fn texts(items: &[&str]) -> Option<ChordValue> {
    Some(ChordValue::Many(
        items.iter().map(|s| (*s).to_owned()).collect(),
    ))
}

fn text(item: &str) -> Option<ChordValue> {
    Some(ChordValue::One(item.to_owned()))
}

#[test]
fn normalizes_case_spacing_modifier_order_and_aliases_to_one_canonical_string() {
    assert_eq!(
        format_chord(&chord(" shift + ctrl + k ", false), false),
        "Ctrl+Shift+K"
    );
    assert_eq!(
        format_chord(&chord("Control+Option+p", false), false),
        "Ctrl+Alt+P"
    );
    assert_eq!(format_chord(&chord("cmd+alt+p", true), true), "Alt+Cmd+P");
    assert_eq!(
        format_chord(&chord("Ctrl+Shift+ArrowUp", false), false),
        "Ctrl+Shift+Up"
    );
    assert_eq!(
        format_chord(&chord("ctrl+shift+↓", false), false),
        "Ctrl+Shift+Down"
    );
    assert_eq!(format_chord(&chord("Ctrl+f5", false), false), "Ctrl+F5");
    assert_eq!(
        format_chord(&chord("Ctrl+Esc", false), false),
        "Ctrl+Escape"
    );
}

#[test]
fn reads_mod_as_cmd_on_macos_and_ctrl_elsewhere() {
    let mac = chord("Mod+Shift+K", true);
    assert!(mac.meta && !mac.ctrl && mac.key == "k");
    let other = chord("Mod+Shift+K", false);
    assert!(!other.meta && other.ctrl && other.key == "k");
}

#[test]
fn writes_the_meta_key_as_cmd_on_macos_and_super_elsewhere_and_reads_both() {
    assert_eq!(format_chord(&chord("Super+K", false), false), "Super+K");
    assert_eq!(format_chord(&chord("Super+K", true), true), "Cmd+K");
    assert_eq!(chord("Meta+K", false), chord("Cmd+K", false));
}

#[test]
fn rejects_unknown_modifiers_unknown_keys_repeats_and_empty_parts() {
    for bad in [
        "",
        "Ctrl+",
        "+K",
        "Hyper+K",
        "Ctrl+Ctrl+K",
        "Ctrl+Shift",
        "Ctrl+Foo",
        "Ctrl++",
    ] {
        assert_eq!(parse_chord(bad, false), None, "{bad}");
    }
}

#[test]
fn accepts_the_digit_range_only_as_a_key_of_its_own() {
    assert_eq!(chord("Ctrl+1-9", false).key, "1-9");
    assert_eq!(parse_chord("Ctrl+1-8", false), None);
}

#[test]
fn shows_arrows_as_glyphs_and_uses_the_platform_style() {
    assert_eq!(
        chord_text(&chord("Ctrl+Shift+Up", false), false),
        "Ctrl+Shift+↑"
    );
    assert_eq!(chord_text(&chord("Cmd+Shift+U", true), true), "⌘⇧U");
    assert_eq!(chord_text(&chord("Ctrl+Alt+Cmd+K", true), true), "⌃⌥⌘K");
    assert_eq!(chord_text(&chord("Super+K", false), false), "Super+K");
}

#[test]
fn ignores_a_modifier_pressed_alone() {
    let control = KeyLike {
        ctrl: true,
        ..event("Control", "")
    };
    let shift = KeyLike {
        shift: true,
        ..event("Shift", "")
    };
    assert_eq!(spec_from_event(&control), None);
    assert_eq!(spec_from_event(&shift), None);
}

#[test]
fn reads_shifted_digits_and_punctuation_from_the_physical_key() {
    assert_eq!(
        spec_from_event(&shifted_ctrl("!", "Digit1")).map(|s| s.key),
        Some("1".to_owned())
    );
    assert_eq!(
        spec_from_event(&shifted_ctrl("<", "Comma")).map(|s| s.key),
        Some(",".to_owned())
    );
}

#[test]
fn keeps_the_layout_letter_when_the_key_is_a_letter() {
    assert_eq!(
        spec_from_event(&shifted_ctrl("Z", "KeyY")).map(|s| s.key),
        Some("z".to_owned())
    );
}

#[test]
fn falls_back_to_the_key_name_without_a_code() {
    let up = KeyLike {
        meta: true,
        ..event("ArrowUp", "")
    };
    assert_eq!(spec_from_event(&up), Some(chord("Cmd+Up", false)));
}

#[test]
fn refuses_plain_ctrl_letter_including_ctrl_r_on_linux() {
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+R", false), false),
        Some(ChordProblem::CtrlKey)
    );
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+K", false), false),
        Some(ChordProblem::CtrlKey)
    );
}

#[test]
fn refuses_plain_ctrl_keys_that_send_control_characters() {
    for key in ["[", "]", "\\", "/", "Space", "Backspace", "Enter"] {
        assert_eq!(
            steals_terminal_key(&chord(&format!("Ctrl+{key}"), false), false),
            Some(ChordProblem::CtrlKey),
            "{key}"
        );
    }
}

#[test]
fn refuses_plain_and_ctrl_arrows_but_allows_ctrl_shift_arrows() {
    assert_eq!(
        steals_terminal_key(&chord("Up", false), false),
        Some(ChordProblem::Bare)
    );
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+Left", false), false),
        Some(ChordProblem::Arrow)
    );
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+Shift+Up", false), false),
        None
    );
}

#[test]
fn refuses_escape_with_any_modifier() {
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+Shift+Escape", false), false),
        Some(ChordProblem::Escape)
    );
    assert_eq!(
        steals_terminal_key(&chord("Cmd+Escape", true), true),
        Some(ChordProblem::Escape)
    );
}

#[test]
fn allows_ctrl_tab_and_ctrl_shift_tab_on_every_platform() {
    for mac in [true, false] {
        assert_eq!(
            steals_terminal_key(&chord("Ctrl+Tab", mac), mac),
            None,
            "{mac}"
        );
        assert_eq!(
            steals_terminal_key(&chord("Ctrl+Shift+Tab", mac), mac),
            None,
            "{mac}"
        );
    }
}

#[test]
fn refuses_tab_without_ctrl_or_with_alt_or_cmd() {
    let rows = [
        ("Tab", false),
        ("Shift+Tab", false),
        ("Alt+Tab", false),
        ("Ctrl+Alt+Tab", false),
        ("Cmd+Tab", true),
        ("Ctrl+Cmd+Tab", true),
    ];
    for (text, mac) in rows {
        assert_eq!(
            steals_terminal_key(&chord(text, mac), mac),
            Some(ChordProblem::Tab),
            "{text}"
        );
    }
}

#[test]
fn refuses_keys_without_ctrl_or_super_on_linux() {
    assert_eq!(
        steals_terminal_key(&chord("K", false), false),
        Some(ChordProblem::Bare)
    );
    assert_eq!(
        steals_terminal_key(&chord("F5", false), false),
        Some(ChordProblem::Bare)
    );
    assert_eq!(
        steals_terminal_key(&chord("Alt+K", false), false),
        Some(ChordProblem::NeedsModifier)
    );
    assert_eq!(
        steals_terminal_key(&chord("Shift+Alt+K", false), false),
        Some(ChordProblem::NeedsModifier)
    );
}

#[test]
fn allows_the_default_chord_shapes_on_linux() {
    for ok in [
        "Ctrl+Shift+P",
        "Ctrl+,",
        "Ctrl+1",
        "Ctrl+1-9",
        "Ctrl+Alt+K",
        "Ctrl+F5",
        "Super+K",
    ] {
        assert_eq!(steals_terminal_key(&chord(ok, false), false), None, "{ok}");
    }
}

#[test]
fn allows_ctrl_pageup_and_ctrl_pagedown_on_linux_which_no_shell_or_monaco_needs() {
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+PageUp", false), false),
        None
    );
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+PageDown", false), false),
        None
    );
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+Home", false), false),
        Some(ChordProblem::CtrlKey)
    );
    assert_eq!(
        steals_terminal_key(&chord("PageUp", false), false),
        Some(ChordProblem::Bare)
    );
    assert_eq!(
        steals_terminal_key(&chord("Alt+PageUp", false), false),
        Some(ChordProblem::NeedsModifier)
    );
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+PageUp", true), true),
        Some(ChordProblem::NeedsModifier)
    );
}

#[test]
fn needs_cmd_on_macos_where_ctrl_and_option_chords_belong_to_the_shell() {
    assert_eq!(steals_terminal_key(&chord("Cmd+K", true), true), None);
    assert_eq!(steals_terminal_key(&chord("Cmd+Up", true), true), None);
    assert_eq!(
        steals_terminal_key(&chord("Ctrl+Shift+P", true), true),
        Some(ChordProblem::NeedsModifier)
    );
    assert_eq!(
        steals_terminal_key(&chord("Alt+K", true), true),
        Some(ChordProblem::NeedsModifier)
    );
}

#[test]
fn lets_a_browser_command_take_a_plain_ctrl_key_because_a_terminal_passes_it_on_to_the_shell() {
    for id in [
        "browser.focusAddress",
        "browser.reload",
        "browser.back",
        "browser.forward",
    ] {
        for text in ["Ctrl+L", "Ctrl+R", "Ctrl+Left"] {
            assert_eq!(
                binding_problem(id, &chord(text, false), false),
                None,
                "{id} {text}"
            );
        }
    }
}

#[test]
fn still_refuses_what_no_browser_command_may_take() {
    let rows = [
        ("Ctrl+Alt+Tab", ChordProblem::Tab),
        ("Ctrl+Escape", ChordProblem::Escape),
        ("F5", ChordProblem::Bare),
        ("Alt+Tab", ChordProblem::Tab),
    ];
    for (text, problem) in rows {
        assert_eq!(
            binding_problem("browser.reload", &chord(text, false), false),
            Some(problem),
            "{text}"
        );
    }
}

#[test]
fn keeps_plain_ctrl_keys_closed_to_every_other_command() {
    assert_eq!(
        binding_problem("palette.toggle", &chord("Ctrl+L", false), false),
        Some(ChordProblem::CtrlKey)
    );
    assert_eq!(
        binding_problem("palette.toggle", &chord("Ctrl+R", false), false),
        Some(ChordProblem::CtrlKey)
    );
    assert_eq!(
        binding_problem("tab.next", &chord("Ctrl+PageDown", false), false),
        None
    );
}

#[test]
fn treats_a_digit_as_part_of_the_1_9_range_with_the_same_modifiers() {
    assert!(overlaps(&chord("Ctrl+3", false), &chord("Ctrl+1-9", false)));
    assert!(!overlaps(
        &chord("Ctrl+Shift+3", false),
        &chord("Ctrl+1-9", false)
    ));
    assert!(!overlaps(
        &chord("Ctrl+0", false),
        &chord("Ctrl+1-9", false)
    ));
    assert!(overlaps(
        &chord("Ctrl+Shift+K", false),
        &chord("shift+ctrl+k", false)
    ));
}

#[test]
fn knows_the_monaco_defaults_of_each_platform() {
    assert!(used_by_monaco(&chord("Ctrl+Shift+K", false), false));
    assert!(!used_by_monaco(&chord("Ctrl+Shift+Y", false), false));
    assert!(used_by_monaco(&chord("Cmd+D", true), true));
    assert!(!used_by_monaco(&chord("Cmd+D", false), false));
}

#[test]
fn reads_a_terminal_prefix_in_any_case_and_writes_it_back_in_one_form() {
    let spec = parse_scoped_chord(" Terminal:Cmd+K ", true).unwrap();
    assert_eq!(
        spec,
        ChordSpec {
            terminal: true,
            ..chord("Cmd+K", true)
        }
    );
    assert_eq!(format_scoped_chord(&spec, true), "terminal:Cmd+K");
    assert_eq!(
        parse_scoped_chord("Cmd+K", true),
        Some(chord("Cmd+K", true))
    );
    assert_eq!(format_scoped_chord(&chord("Cmd+K", true), true), "Cmd+K");
}

#[test]
fn refuses_a_prefix_with_no_chord_and_any_other_prefix() {
    assert_eq!(parse_scoped_chord("terminal:", true), None);
    assert_eq!(parse_scoped_chord("terminal:Ctrl+Nope", false), None);
    assert_eq!(parse_scoped_chord("editor:Cmd+K", true), None);
}

#[test]
fn tells_chords_of_a_terminal_from_chords_of_the_whole_window() {
    let in_terminal = parse_scoped_chord("terminal:Cmd+D", true).unwrap();
    assert!(!same_scope(&in_terminal, &chord("Cmd+D", true)));
    assert!(same_scope(
        &in_terminal,
        &parse_scoped_chord("terminal:Cmd+K", true).unwrap()
    ));
    assert!(same_scope(&chord("Cmd+D", true), &chord("Cmd+K", true)));
}

#[test]
fn checks_a_prefixed_binding_by_the_chord_after_the_prefix() {
    assert_eq!(
        check_binding("terminal.clear", "terminal:Ctrl+Shift+K", false),
        None
    );
    assert_eq!(
        check_binding("terminal.clear", "terminal:Ctrl+K", false),
        Some(ChordProblem::CtrlKey)
    );
    assert_eq!(
        check_binding("terminal.clear", "terminal:", false),
        Some(ChordProblem::Invalid)
    );
}

#[test]
fn keeps_chord_strings_and_nulls_and_drops_everything_else() {
    let raw: Value = serde_json::from_str(
        "{\"palette.toggle\":\"Cmd+J\",\"view.toggleRail\":null,\"history.search\":7,\
         \"workspace.new\":\"Ctrl+Nope\",\"__proto__\":\"Ctrl+Shift+X\"}",
    )
    .unwrap();
    let expected = BTreeMap::from([
        ("palette.toggle".to_owned(), text("Cmd+J")),
        ("view.toggleRail".to_owned(), None),
    ]);
    assert_eq!(parse_keybindings(&raw), expected);
}

#[test]
fn keeps_a_list_of_chords_trimmed_and_without_repeats_and_drops_the_entries_that_do_not_parse() {
    let many: Vec<String> = (1..=12).map(|i| format!("Ctrl+F{i}")).collect();
    let raw = json!({
        "tab.next": [" Ctrl+Tab ", "Shift+Cmd+]", "Ctrl+Tab", "Ctrl+Nope", 7],
        "pane.splitRight": ["terminal:Cmd+D", "terminal:", "Cmd+Alt+\\"],
        "view.zoomIn": ["Ctrl+Nope"],
        "view.zoomOut": [],
        "find": many,
    });
    let capped: Vec<String> = (1..=CHORDS_PER_COMMAND_MAX)
        .map(|i| format!("Ctrl+F{i}"))
        .collect();
    let expected = BTreeMap::from([
        ("tab.next".to_owned(), texts(&["Ctrl+Tab", "Shift+Cmd+]"])),
        (
            "pane.splitRight".to_owned(),
            texts(&["terminal:Cmd+D", "Cmd+Alt+\\"]),
        ),
        ("find".to_owned(), Some(ChordValue::Many(capped))),
    ]);
    assert_eq!(parse_keybindings(&raw), expected);
}

#[test]
fn returns_an_empty_map_for_a_non_object() {
    assert!(parse_keybindings(&json!(["Ctrl+K"])).is_empty());
    assert!(parse_keybindings(&json!("Ctrl+K")).is_empty());
}

#[derive(Clone, Copy)]
enum Step {
    Down,
    Up,
}

fn shift() -> TapKey {
    TapKey {
        key: "Shift".to_owned(),
        ctrl: false,
        meta: false,
        alt: false,
        repeat: false,
        is_composing: false,
    }
}

fn other(key: &str) -> TapKey {
    TapKey {
        key: key.to_owned(),
        ..shift()
    }
}

fn run(steps: &[(Step, TapKey, u64)]) -> usize {
    let mut detector = DoubleShiftDetector::new();
    let mut fired = 0;
    for (step, key, at) in steps {
        match step {
            Step::Down => detector.down(key, *at),
            Step::Up => {
                if detector.up(key, *at) {
                    fired += 1;
                }
            }
        }
    }
    fired
}

fn tap(at: u64) -> Vec<(Step, TapKey, u64)> {
    vec![(Step::Down, shift(), at), (Step::Up, shift(), at + 50)]
}

#[test]
fn parses_shift_shift_as_its_own_chord_and_prints_it_back() {
    let spec = chord(DOUBLE_SHIFT, false);
    assert_eq!(format_chord(&spec, false), "Shift+Shift");
    assert_eq!(chord_text(&spec, true), "⇧⇧");
    assert_eq!(chord_text(&spec, false), "Shift+Shift");
    let pressed = KeyLike {
        shift: true,
        ..event("Shift", "ShiftLeft")
    };
    assert_eq!(spec_from_event(&pressed), None);
}

#[test]
fn refuses_shift_on_its_own_or_with_another_modifier() {
    assert_eq!(parse_chord("Shift", false), None);
    assert_eq!(parse_chord("Ctrl+Shift", false), None);
    assert_eq!(parse_chord("Cmd+Shift", true), None);
    assert_eq!(parse_chord("Shift+Shift+Shift", false), None);
}

#[test]
fn binds_to_app_commands_only_never_in_the_terminal_scope_or_to_browser_keys() {
    assert_eq!(
        binding_problem(
            "palette.searchEverywhere",
            &chord(DOUBLE_SHIFT, false),
            false
        ),
        None
    );
    assert_eq!(
        binding_problem("palette.toggle", &chord(DOUBLE_SHIFT, true), true),
        None
    );
    assert_eq!(
        check_binding("palette.toggle", &format!("terminal:{DOUBLE_SHIFT}"), false),
        Some(ChordProblem::Invalid)
    );
    assert_eq!(
        check_binding("browser.reload", DOUBLE_SHIFT, false),
        Some(ChordProblem::Invalid)
    );
}

#[test]
fn refuses_every_terminal_only_command_which_shift_twice_could_never_run() {
    for id in TERMINAL_CHORD_IDS {
        assert_eq!(
            check_binding(id, DOUBLE_SHIFT, false),
            Some(ChordProblem::Invalid),
            "{id}"
        );
        assert_eq!(
            check_binding(id, DOUBLE_SHIFT, true),
            Some(ChordProblem::Invalid),
            "{id}"
        );
    }
}

#[test]
fn fires_on_the_second_of_two_lone_shift_taps_close_together() {
    let steps = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (Step::Down, shift(), 300),
        (Step::Up, shift(), 380),
    ];
    assert_eq!(run(&steps), 1);
}

#[test]
fn does_not_fire_for_a_single_tap_or_taps_too_far_apart() {
    assert_eq!(run(&[(Step::Down, shift(), 0), (Step::Up, shift(), 80)]), 0);
    let apart = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (Step::Down, shift(), 381),
        (Step::Up, shift(), 450),
    ];
    assert_eq!(run(&apart), 0);
}

#[test]
fn does_not_fire_when_shift_is_held() {
    let held_second = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (Step::Down, shift(), 150),
        (Step::Up, shift(), 451),
    ];
    assert_eq!(run(&held_second), 0);
    let held_first = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 400),
        (Step::Down, shift(), 450),
        (Step::Up, shift(), 500),
    ];
    assert_eq!(run(&held_first), 0);
}

#[test]
fn does_not_count_a_shift_held_with_key_repeat_as_a_tap() {
    let mut steps = vec![(Step::Down, shift(), 0)];
    for at in [30, 60, 90, 120] {
        steps.push((
            Step::Down,
            TapKey {
                repeat: true,
                ..shift()
            },
            at,
        ));
    }
    steps.extend([
        (Step::Up, shift(), 140),
        (Step::Down, shift(), 200),
        (Step::Up, shift(), 250),
    ]);
    assert_eq!(run(&steps), 0);
}

#[test]
fn does_not_fire_when_another_key_comes_between_or_rides_on_shift() {
    let between = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (Step::Down, other("a"), 100),
        (Step::Up, other("a"), 120),
        (Step::Down, shift(), 150),
        (Step::Up, shift(), 200),
    ];
    assert_eq!(run(&between), 0);
    let rides = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (Step::Down, shift(), 150),
        (Step::Down, other("A"), 160),
        (Step::Up, other("A"), 170),
        (Step::Up, shift(), 200),
    ];
    assert_eq!(run(&rides), 0);
    let with_ctrl = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (
            Step::Down,
            TapKey {
                ctrl: true,
                ..shift()
            },
            150,
        ),
        (Step::Up, shift(), 200),
    ];
    assert_eq!(run(&with_ctrl), 0);
}

#[test]
fn does_not_fire_while_an_input_method_is_composing() {
    let steps = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (
            Step::Down,
            TapKey {
                is_composing: true,
                ..shift()
            },
            150,
        ),
        (Step::Up, shift(), 200),
    ];
    assert_eq!(run(&steps), 0);
}

#[test]
fn fires_once_for_three_quick_taps_and_again_for_a_fourth() {
    let three: Vec<_> = [0, 100, 200].into_iter().flat_map(tap).collect();
    assert_eq!(run(&three), 1);
    let four: Vec<_> = [0, 100, 200, 300].into_iter().flat_map(tap).collect();
    assert_eq!(run(&four), 2);
}

#[test]
fn starts_over_after_reset() {
    let mut detector = DoubleShiftDetector::new();
    detector.down(&shift(), 0);
    detector.up(&shift(), 50);
    detector.reset();
    detector.down(&shift(), 100);
    assert!(!detector.up(&shift(), 150));
}

#[test]
fn counts_a_hold_and_a_gap_of_exactly_300_ms_as_a_tap_and_a_double() {
    let edge = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 300),
        (Step::Down, shift(), 600),
        (Step::Up, shift(), 900),
    ];
    assert_eq!(run(&edge), 1);
    let too_long = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (Step::Down, shift(), 380),
        (Step::Up, shift(), 681),
    ];
    assert_eq!(run(&too_long), 0);
}

#[test]
fn ignores_the_release_of_another_key_and_a_release_with_no_press() {
    let steps = [
        (Step::Down, shift(), 0),
        (Step::Up, shift(), 80),
        (Step::Down, shift(), 150),
        (Step::Up, other("a"), 160),
        (Step::Up, shift(), 200),
    ];
    assert_eq!(run(&steps), 1);
    assert_eq!(run(&[(Step::Up, shift(), 10)]), 0);
}

#[test]
fn gives_a_string_value_and_a_list_as_one_list_of_texts() {
    assert_eq!(
        chord_texts(&ChordValue::One("Ctrl+K".to_owned())),
        vec!["Ctrl+K"]
    );
    assert_eq!(
        chord_texts(&ChordValue::Many(vec![
            "Ctrl+K".to_owned(),
            "Cmd+K".to_owned()
        ])),
        vec!["Ctrl+K", "Cmd+K"]
    );
}

#[test]
fn holds_the_constants_that_callers_match_on() {
    assert_eq!(CHORDS_PER_COMMAND_MAX, 8);
    assert_eq!(DIGIT_RANGE, "1-9");
    assert_eq!(DOUBLE_SHIFT, "Shift+Shift");
    assert_eq!(TERMINAL_SCOPE, "terminal:");
    assert_eq!(WORKSPACE_GOTO, "workspace.goto");
    assert_eq!(PALETTE_TOGGLE, "palette.toggle");
    assert_eq!(
        BROWSER_CHORD_IDS,
        [
            "browser.focusAddress",
            "browser.reload",
            "browser.back",
            "browser.forward"
        ]
    );
    assert_eq!(
        TERMINAL_COMMAND_CHORD_IDS,
        [
            "terminal.scrollToTop",
            "terminal.scrollToBottom",
            "terminal.scrollPageUp",
            "terminal.scrollPageDown",
            "terminal.scrollLineUp",
            "terminal.scrollLineDown",
            "terminal.reviewOutput",
            "tab.moveLeft",
            "tab.moveRight"
        ]
    );
    let expected: Vec<&str> = [
        "copy",
        "paste",
        "find",
        "find.next",
        "find.previous",
        "block.selectPrev",
        "block.selectNext",
    ]
    .into_iter()
    .chain(TERMINAL_COMMAND_CHORD_IDS)
    .collect();
    assert_eq!(TERMINAL_CHORD_IDS.to_vec(), expected);
}

#[test]
fn recognises_double_shift_by_its_spec_and_by_its_key_event() {
    assert!(is_double_shift(&chord(DOUBLE_SHIFT, false)));
    assert!(!is_double_shift(&chord("Ctrl+K", false)));
    assert!(is_double_shift_key(&event("Shift", "ShiftRight")));
    assert!(!is_double_shift_key(&event("a", "KeyA")));
    assert_eq!(DOUBLE_SHIFT_KEY.key, "Shift");
    assert_eq!(DOUBLE_SHIFT_KEY.code, "ShiftLeft");
    assert!(DOUBLE_SHIFT_KEY.shift);
    assert!(!DOUBLE_SHIFT_KEY.ctrl && !DOUBLE_SHIFT_KEY.meta && !DOUBLE_SHIFT_KEY.alt);
}

#[test]
fn lets_bare_f1_open_the_palette_and_nothing_else() {
    let f1 = chord("F1", false);
    assert!(is_palette_f1(PALETTE_TOGGLE, &f1));
    assert!(!is_palette_f1("tab.next", &f1));
    assert!(!is_palette_f1(PALETTE_TOGGLE, &chord("Ctrl+F1", false)));
    assert!(!is_palette_f1(PALETTE_TOGGLE, &chord("F2", false)));
    let scoped = parse_scoped_chord("terminal:F1", false).unwrap();
    assert!(!is_palette_f1(PALETTE_TOGGLE, &scoped));
    assert_eq!(binding_problem(PALETTE_TOGGLE, &f1, false), None);
    assert_eq!(binding_problem(PALETTE_TOGGLE, &f1, true), None);
    assert_eq!(
        binding_problem("tab.next", &f1, false),
        Some(ChordProblem::Bare)
    );
    assert_eq!(
        binding_problem(PALETTE_TOGGLE, &scoped, false),
        Some(ChordProblem::Bare)
    );
}

#[test]
fn keeps_the_digit_range_for_workspace_goto_alone() {
    assert_eq!(
        binding_problem(WORKSPACE_GOTO, &chord("Ctrl+1-9", false), false),
        None
    );
    assert_eq!(
        binding_problem(WORKSPACE_GOTO, &chord("Ctrl+1", false), false),
        Some(ChordProblem::DigitRange)
    );
    assert_eq!(
        binding_problem("tab.goto", &chord("Ctrl+1-9", false), false),
        Some(ChordProblem::DigitRange)
    );
    assert_eq!(
        binding_problem("tab.goto", &chord("Ctrl+1", false), false),
        None
    );
}

#[test]
fn lets_browser_commands_take_alt_chords_and_ctrl_chords_on_every_platform_but_not_a_shell_owned_key()
 {
    assert_eq!(
        binding_problem("browser.back", &chord("Alt+Left", false), false),
        None
    );
    assert_eq!(
        binding_problem("browser.reload", &chord("Ctrl+L", true), true),
        None
    );
    assert_eq!(
        binding_problem("browser.reload", &chord("Alt+Escape", false), false),
        Some(ChordProblem::Escape)
    );
    assert_eq!(
        binding_problem("browser.reload", &chord("Alt+K", true), true),
        None
    );
    assert_eq!(
        binding_problem("browser.reload", &chord("Ctrl+Shift+L", false), false),
        None
    );
}

#[test]
fn recognises_a_native_clipboard_key_only_as_cmd_c_or_cmd_v() {
    let key = |k: &str, ctrl: bool, meta: bool, shift: bool, alt: bool| KeyLike {
        key: k.to_owned(),
        code: String::new(),
        ctrl,
        meta,
        shift,
        alt,
    };
    assert!(is_native_clipboard_key(&key(
        "c", false, true, false, false
    )));
    assert!(is_native_clipboard_key(&key(
        "V", false, true, false, false
    )));
    assert!(!is_native_clipboard_key(&key(
        "c", false, true, true, false
    )));
    assert!(!is_native_clipboard_key(&key(
        "c", true, true, false, false
    )));
    assert!(!is_native_clipboard_key(&key(
        "c", false, true, false, true
    )));
    assert!(!is_native_clipboard_key(&key(
        "c", true, false, false, false
    )));
    assert!(!is_native_clipboard_key(&key(
        "x", false, true, false, false
    )));
    assert!(!is_native_clipboard_key(&key(
        "Meta", false, true, false, false
    )));
}

#[test]
fn reads_the_named_keys_function_keys_and_punctuation_of_a_chord() {
    let rows = [
        ("Ctrl+Space", "space"),
        ("Ctrl+Return", "enter"),
        ("Ctrl+Del", "delete"),
        ("Ctrl+F1", "f1"),
        ("Ctrl+f24", "f24"),
        ("Ctrl+`", "`"),
        ("Ctrl+\\", "\\"),
        ("Ctrl+9", "9"),
        ("Ctrl+→", "right"),
    ];
    for (text, key) in rows {
        let parsed = parse_chord(text, false);
        assert_eq!(parsed.map(|s| s.key), Some(key.to_owned()), "{text}");
    }
    for bad in [
        "Ctrl+pgup",
        "Ctrl+F0",
        "Ctrl+F25",
        "Ctrl+F100",
        "Ctrl+ab",
        "Ctrl+!",
        "Ctrl+Shift+Shift",
    ] {
        assert_eq!(parse_chord(bad, false), None, "{bad}");
    }
}

#[test]
fn refuses_two_modifiers_that_mean_the_same_flag() {
    for bad in [
        "Ctrl+Control+K",
        "Cmd+Super+K",
        "Alt+Option+K",
        "Mod+Ctrl+K",
    ] {
        assert_eq!(parse_chord(bad, false), None, "{bad}");
    }
    assert_eq!(parse_chord("Mod+Cmd+K", true), None);
    assert!(parse_chord("Mod+Cmd+K", false).is_some());
}

#[test]
fn writes_function_keys_digits_and_punctuation_in_a_fixed_form() {
    assert_eq!(format_chord(&chord("ctrl+f12", false), false), "Ctrl+F12");
    assert_eq!(format_chord(&chord("Ctrl+1-9", false), false), "Ctrl+1-9");
    assert_eq!(format_chord(&chord("Ctrl+,", false), false), "Ctrl+,");
    assert_eq!(
        format_chord(&chord("Ctrl+PageUp", false), false),
        "Ctrl+PageUp"
    );
    assert_eq!(
        format_chord(&chord("Shift+Alt+Super+K", false), false),
        "Shift+Alt+Super+K"
    );
    assert_eq!(chord_text(&chord("Cmd+Up", true), true), "⌘↑");
    assert_eq!(chord_text(&chord("Super+Up", false), false), "Super+↑");
    assert_eq!(chord_text(&chord("Ctrl+Alt+K", true), true), "⌃⌥K");
}

#[test]
fn compares_chords_by_modifiers_and_key_and_not_by_scope() {
    let scoped = parse_scoped_chord("terminal:Cmd+K", true).unwrap();
    assert!(same_chord(&scoped, &chord("Cmd+K", true)));
    assert!(overlaps(&scoped, &chord("Cmd+K", true)));
    assert!(overlaps(&chord("Ctrl+1-9", false), &chord("Ctrl+3", false)));
    assert!(overlaps(
        &chord("Ctrl+1-9", false),
        &chord("Ctrl+1-9", false)
    ));
    assert!(!overlaps(&chord("Ctrl+1-9", false), &chord("Alt+3", false)));
    assert!(!same_chord(
        &chord("Ctrl+K", false),
        &chord("Ctrl+J", false)
    ));
}

#[test]
fn reads_a_key_event_by_code_and_by_name_when_the_code_is_not_known() {
    let rows = [
        (event("a", ""), Some("a")),
        (event("A", ""), Some("a")),
        (event("5", ""), Some("5")),
        (event("5", "Numpad5"), Some("5")),
        (event("Process", "KeyQ"), Some("q")),
        (event("Dead", "F5"), Some("f5")),
        (event("Dead", "F24"), Some("f24")),
        (event("Dead", "F25"), None),
        (event("Enter", "NumpadEnter"), Some("enter")),
        (event("Dead", "BracketLeft"), Some("[")),
        (event("Dead", "Backquote"), Some("`")),
        (event("Dead", "ArrowRight"), Some("right")),
        (event("Dead", ""), None),
        (event("AltGraph", ""), None),
        (event("OS", ""), None),
        (event("Meta", ""), None),
        (event("Hyper", ""), None),
        (event("Super", ""), None),
        (event(",", ""), Some(",")),
        (event(" ", ""), Some("space")),
    ];
    for (key, expected) in rows {
        assert_eq!(
            spec_from_event(&key).map(|s| s.key),
            expected.map(str::to_owned),
            "{} {}",
            key.key,
            key.code
        );
    }
    let flags = KeyLike {
        ctrl: true,
        alt: true,
        ..event("k", "KeyK")
    };
    let spec = spec_from_event(&flags).unwrap();
    assert!(spec.ctrl && spec.alt && !spec.shift && !spec.meta && !spec.terminal);
}

#[test]
fn knows_more_monaco_defaults_and_ignores_the_other_platform_list() {
    assert!(used_by_monaco(&chord("Ctrl+Shift+Space", false), false));
    assert!(used_by_monaco(&chord("Ctrl+F12", false), false));
    assert!(used_by_monaco(&chord("Ctrl+Alt+Up", false), false));
    assert!(used_by_monaco(&chord("Alt+Cmd+F", true), true));
    assert!(used_by_monaco(&chord("Shift+Cmd+K", true), true));
    assert!(used_by_monaco(&chord("Cmd+/", true), true));
    assert!(!used_by_monaco(&chord("Ctrl+Shift+K", true), true));
    assert!(!used_by_monaco(&chord("Super+Shift+K", false), false));
}

#[test]
fn reads_a_scope_prefix_with_a_space_after_it_and_refuses_a_doubled_prefix() {
    let spec = parse_scoped_chord("terminal: Cmd+K", true).unwrap();
    assert!(spec.terminal);
    assert_eq!(spec.key, "k");
    assert_eq!(
        parse_scoped_chord("TERMINAL:ctrl+k", false).map(|s| s.terminal),
        Some(true)
    );
    assert_eq!(parse_scoped_chord("terminal:terminal:Cmd+K", true), None);
    assert_eq!(parse_scoped_chord("", true), None);
}

#[test]
fn drops_unsafe_and_empty_ids_and_keeps_only_valid_chord_values() {
    let raw: Value = serde_json::from_str(
        "{\"\":\"Ctrl+K\",\"constructor\":\"Ctrl+K\",\"prototype\":\"Ctrl+K\",\
         \"__proto__\":null,\"a\":true,\"b\":{\"x\":1},\"c\":[7,false,null],\
         \"d\":\" Ctrl+K \",\"e\":\"Mod+K\",\"f\":[\"Ctrl+K\",\"Ctrl+K\",\"Cmd+K\"],\
         \"g\":\"\",\"h\":\"   \"}",
    )
    .unwrap();
    let expected = BTreeMap::from([
        ("d".to_owned(), text("Ctrl+K")),
        ("e".to_owned(), text("Mod+K")),
        ("f".to_owned(), texts(&["Ctrl+K", "Cmd+K"])),
    ]);
    assert_eq!(parse_keybindings(&raw), expected);
    assert!(parse_keybindings(&Value::Null).is_empty());
    assert!(parse_keybindings(&json!(7)).is_empty());
}
