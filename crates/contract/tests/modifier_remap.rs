#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use ostia_contract::modifier_remap::{
    ModifierFlags, ModifierRemap, RemapKey, RemapTarget, is_identity_remap, is_retargeted,
    parse_modifier_remap, release_stale, remap_target, remapped_flags, remapped_modifier_key,
    same_flags, track_modifier_key,
};
use serde_json::{Value, json};

const NONE: ModifierFlags = ModifierFlags {
    ctrl: false,
    alt: false,
    meta: false,
};

fn flags(ctrl: bool, alt: bool, meta: bool) -> ModifierFlags {
    ModifierFlags { ctrl, alt, meta }
}

fn table<const N: usize>(entries: [(RemapKey, RemapTarget); N]) -> ModifierRemap {
    ModifierRemap::from(entries)
}

fn down<const N: usize>(keys: [RemapKey; N]) -> BTreeSet<RemapKey> {
    BTreeSet::from(keys)
}

#[test]
fn keeps_only_valid_non_default_entries() {
    let parsed = parse_modifier_remap(&json!({
        "ControlLeft": "command",
        "ControlRight": "control",
        "AltLeft": "shift",
        "Bogus": "option",
        "MetaRight": "option",
    }));
    assert_eq!(
        parsed,
        table([
            (RemapKey::ControlLeft, RemapTarget::Command),
            (RemapKey::MetaRight, RemapTarget::Option),
        ])
    );
}

#[test]
fn reads_anything_that_is_not_an_object_as_the_defaults() {
    for raw in [
        Value::Null,
        json!("x"),
        json!(3),
        json!(["ControlLeft"]),
        json!(true),
    ] {
        assert_eq!(parse_modifier_remap(&raw), ModifierRemap::new(), "{raw}");
    }
}

#[test]
fn knows_the_identity_table() {
    assert!(is_identity_remap(&ModifierRemap::new()));
    assert!(!is_identity_remap(&table([(
        RemapKey::AltRight,
        RemapTarget::Command
    )])));
}

#[test]
fn leaves_every_flag_alone_with_the_default_table() {
    assert_eq!(
        remapped_flags(
            &ModifierRemap::new(),
            &down([RemapKey::MetaLeft]),
            flags(false, false, true)
        ),
        flags(false, false, true)
    );
}

#[test]
fn maps_one_physical_key_to_the_chosen_modifier() {
    let remap = table([(RemapKey::MetaRight, RemapTarget::Control)]);
    assert_eq!(
        remapped_flags(
            &remap,
            &down([RemapKey::MetaRight]),
            flags(false, false, true)
        ),
        flags(true, false, false)
    );
}

#[test]
fn maps_the_left_and_right_key_of_a_pair_separately() {
    let remap = table([(RemapKey::AltRight, RemapTarget::Command)]);
    let real = flags(false, true, false);
    assert_eq!(
        remapped_flags(&remap, &down([RemapKey::AltLeft]), real),
        flags(false, true, false)
    );
    assert_eq!(
        remapped_flags(&remap, &down([RemapKey::AltRight]), real),
        flags(false, false, true)
    );
    assert_eq!(
        remapped_flags(&remap, &down([RemapKey::AltLeft, RemapKey::AltRight]), real),
        flags(false, true, true)
    );
}

#[test]
fn swaps_two_keys_without_mapping_twice() {
    let remap = table([
        (RemapKey::ControlLeft, RemapTarget::Command),
        (RemapKey::MetaLeft, RemapTarget::Control),
    ]);
    assert_eq!(
        remapped_flags(
            &remap,
            &down([RemapKey::ControlLeft, RemapKey::MetaLeft]),
            flags(true, false, true)
        ),
        flags(true, false, true)
    );
    assert_eq!(
        remapped_flags(
            &remap,
            &down([RemapKey::ControlLeft]),
            flags(true, false, false)
        ),
        flags(false, false, true)
    );
}

#[test]
fn ignores_a_tracked_key_the_system_no_longer_reports_held() {
    assert_eq!(
        remapped_flags(
            &table([(RemapKey::ControlLeft, RemapTarget::Option)]),
            &down([RemapKey::ControlLeft]),
            NONE
        ),
        NONE
    );
}

#[test]
fn treats_a_held_modifier_the_tracker_never_saw_as_itself() {
    assert_eq!(
        remapped_flags(
            &table([(RemapKey::ControlLeft, RemapTarget::Option)]),
            &down([]),
            flags(true, false, false)
        ),
        flags(true, false, false)
    );
}

#[test]
fn tracks_only_the_six_physical_modifier_codes() {
    let mut held = BTreeSet::new();
    track_modifier_key(&mut held, "ShiftLeft", true);
    track_modifier_key(&mut held, "KeyA", true);
    track_modifier_key(&mut held, "MetaRight", true);
    assert_eq!(
        held.iter().copied().collect::<Vec<_>>(),
        [RemapKey::MetaRight]
    );
    track_modifier_key(&mut held, "MetaRight", false);
    assert!(held.is_empty());
}

#[test]
fn names_the_key_a_modifier_press_now_stands_for() {
    assert_eq!(
        remapped_modifier_key(
            &table([(RemapKey::ControlLeft, RemapTarget::Command)]),
            "ControlLeft"
        ),
        Some("Meta")
    );
    assert_eq!(
        remapped_modifier_key(&ModifierRemap::new(), "AltRight"),
        Some("Alt")
    );
    assert_eq!(remapped_modifier_key(&ModifierRemap::new(), "KeyA"), None);
}

#[test]
fn is_true_only_for_a_modifier_key_the_table_sends_somewhere_else() {
    let remap = table([(RemapKey::ControlRight, RemapTarget::Command)]);
    assert!(is_retargeted(&remap, "ControlRight"));
    assert!(!is_retargeted(&remap, "ControlLeft"));
    assert!(!is_retargeted(&remap, "KeyK"));
}

#[test]
fn drops_the_held_keys_of_a_modifier_family_the_event_no_longer_reports() {
    let mut held = down([
        RemapKey::ControlRight,
        RemapKey::AltLeft,
        RemapKey::MetaLeft,
    ]);
    release_stale(&mut held, flags(false, true, true));
    assert_eq!(
        held.iter().copied().collect::<Vec<_>>(),
        [RemapKey::AltLeft, RemapKey::MetaLeft]
    );
}

#[test]
fn reads_each_of_the_six_key_codes_and_each_of_the_three_targets() {
    let table_of_moves = [
        (
            "ControlLeft",
            "option",
            RemapKey::ControlLeft,
            RemapTarget::Option,
        ),
        (
            "ControlRight",
            "command",
            RemapKey::ControlRight,
            RemapTarget::Command,
        ),
        (
            "AltLeft",
            "control",
            RemapKey::AltLeft,
            RemapTarget::Control,
        ),
        (
            "AltRight",
            "command",
            RemapKey::AltRight,
            RemapTarget::Command,
        ),
        (
            "MetaLeft",
            "control",
            RemapKey::MetaLeft,
            RemapTarget::Control,
        ),
        (
            "MetaRight",
            "option",
            RemapKey::MetaRight,
            RemapTarget::Option,
        ),
    ];
    for (code, target, key, expected) in table_of_moves {
        let parsed = parse_modifier_remap(&json!({ code: target }));
        assert_eq!(parsed, table([(key, expected)]), "{code}");
    }
}

#[test]
fn drops_an_entry_whose_target_is_not_a_known_string() {
    for target in [
        json!(null),
        json!(3),
        json!(true),
        json!(["command"]),
        json!({"to": "command"}),
        json!("Command"),
        json!(""),
    ] {
        let parsed = parse_modifier_remap(&json!({ "ControlLeft": target }));
        assert_eq!(parsed, ModifierRemap::new(), "{target}");
    }
}

#[test]
fn answers_the_default_target_for_a_key_the_table_does_not_hold() {
    let empty = ModifierRemap::new();
    let defaults = [
        (RemapKey::ControlLeft, RemapTarget::Control),
        (RemapKey::ControlRight, RemapTarget::Control),
        (RemapKey::AltLeft, RemapTarget::Option),
        (RemapKey::AltRight, RemapTarget::Option),
        (RemapKey::MetaLeft, RemapTarget::Command),
        (RemapKey::MetaRight, RemapTarget::Command),
    ];
    for (key, target) in defaults {
        assert_eq!(remap_target(&empty, key), target, "{key:?}");
    }
}

#[test]
fn answers_the_table_target_for_a_key_the_table_holds() {
    let remap = table([(RemapKey::AltLeft, RemapTarget::Control)]);
    assert_eq!(
        remap_target(&remap, RemapKey::AltLeft),
        RemapTarget::Control
    );
    assert_eq!(
        remap_target(&remap, RemapKey::AltRight),
        RemapTarget::Option
    );
}

#[test]
fn names_each_target_key_as_the_browser_does() {
    let cases = [
        ("ControlLeft", "Control"),
        ("ControlRight", "Control"),
        ("AltLeft", "Alt"),
        ("AltRight", "Alt"),
        ("MetaLeft", "Meta"),
        ("MetaRight", "Meta"),
    ];
    for (code, expected) in cases {
        assert_eq!(
            remapped_modifier_key(&ModifierRemap::new(), code),
            Some(expected),
            "{code}"
        );
    }
}

#[test]
fn does_not_track_a_code_that_only_looks_like_a_modifier() {
    let mut held = BTreeSet::new();
    for code in [
        "ControlLeft ",
        "controlleft",
        "Control",
        "Alt",
        "Meta",
        "OSLeft",
        "",
    ] {
        track_modifier_key(&mut held, code, true);
    }
    assert!(held.is_empty());
}

#[test]
fn releases_every_family_when_the_event_reports_no_modifier() {
    let mut held = down([
        RemapKey::ControlLeft,
        RemapKey::ControlRight,
        RemapKey::AltLeft,
        RemapKey::AltRight,
        RemapKey::MetaLeft,
        RemapKey::MetaRight,
    ]);
    release_stale(&mut held, NONE);
    assert!(held.is_empty());
}

#[test]
fn keeps_every_held_key_when_the_event_reports_all_modifiers() {
    let all = [
        RemapKey::ControlLeft,
        RemapKey::AltRight,
        RemapKey::MetaLeft,
    ];
    let mut held = down(all);
    release_stale(&mut held, flags(true, true, true));
    assert_eq!(held, down(all));
}

#[test]
fn sends_two_keys_to_one_modifier_without_doubling_it() {
    let remap = table([
        (RemapKey::ControlLeft, RemapTarget::Command),
        (RemapKey::ControlRight, RemapTarget::Command),
    ]);
    assert_eq!(
        remapped_flags(
            &remap,
            &down([RemapKey::ControlLeft, RemapKey::ControlRight]),
            flags(true, false, false)
        ),
        flags(false, false, true)
    );
}

#[test]
fn keeps_a_flag_the_event_reports_when_the_tracker_holds_only_a_remapped_pair_member() {
    let remap = table([(RemapKey::ControlLeft, RemapTarget::Option)]);
    assert_eq!(
        remapped_flags(
            &remap,
            &down([RemapKey::ControlLeft]),
            flags(true, false, true)
        ),
        flags(false, true, true)
    );
}

#[test]
fn compares_flags_field_by_field() {
    assert!(same_flags(
        flags(true, false, true),
        flags(true, false, true)
    ));
    assert!(same_flags(NONE, NONE));
    assert!(!same_flags(
        flags(true, false, false),
        flags(false, false, false)
    ));
    assert!(!same_flags(
        flags(false, true, false),
        flags(false, false, false)
    ));
    assert!(!same_flags(
        flags(false, false, true),
        flags(false, false, false)
    ));
}
