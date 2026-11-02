#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_browser::guest_inject::GuestInject;
use ostia_browser::guest_key::GuestKeyInput;
use ostia_browser::guest_key_event::KeyboardInputEvent;
use ostia_browser::guest_remap::GuestRemap;
use serde_json::json;

fn create_with(
    native_menu_key: impl Fn(&GuestKeyInput) -> bool + Send + Sync + 'static,
) -> (GuestRemap, GuestInject) {
    let inject = GuestInject::new();
    (GuestRemap::new(inject.clone(), native_menu_key), inject)
}

fn create() -> GuestRemap {
    create_with(|_| false).0
}

fn key() -> GuestKeyInput {
    GuestKeyInput {
        kind: "keyDown".to_owned(),
        key: "k".to_owned(),
        code: "KeyK".to_owned(),
        ..GuestKeyInput::default()
    }
}

fn event(kind: &str, key_code: &str, modifiers: &[&str]) -> KeyboardInputEvent {
    KeyboardInputEvent {
        kind: kind.to_owned(),
        key_code: key_code.to_owned(),
        modifiers: modifiers.iter().map(|m| (*m).to_owned()).collect(),
    }
}

fn remap_down(guest: &GuestRemap, code: &str, flag: &str) {
    let mut input = GuestKeyInput {
        code: code.to_owned(),
        key: "Modifier".to_owned(),
        ..key()
    };
    match flag {
        "control" => input.control = true,
        "alt" => input.alt = true,
        "meta" => input.meta = true,
        other => panic!("unknown flag {other}"),
    }
    guest.remap(1, &input);
}

#[test]
fn returns_the_same_input_with_the_default_table() {
    let guest = create();
    let input = GuestKeyInput {
        meta: true,
        ..key()
    };
    assert_eq!(guest.remap(1, &input), input);
}

#[test]
fn rewrites_the_modifiers_of_a_key_by_the_physical_key_held_and_marks_it() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command", "AltLeft": "control"}));
    remap_down(&guest, "ControlRight", "control");
    let mapped = guest.remap(
        1,
        &GuestKeyInput {
            control: true,
            ..key()
        },
    );
    assert!(!mapped.control);
    assert!(mapped.meta);
    assert!(mapped.remapped);
    guest.remap(
        1,
        &GuestKeyInput {
            code: "AltLeft".to_owned(),
            key: "Alt".to_owned(),
            control: true,
            alt: true,
            ..key()
        },
    );
    let mapped = guest.remap(
        1,
        &GuestKeyInput {
            control: true,
            alt: true,
            ..key()
        },
    );
    assert!(mapped.control);
    assert!(mapped.meta);
    assert!(!mapped.alt);
}

#[test]
fn tracks_each_guest_on_its_own_and_forgets_a_closed_one() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command"}));
    remap_down(&guest, "ControlRight", "control");
    let control = GuestKeyInput {
        control: true,
        ..key()
    };
    assert!(!guest.remap(2, &control).meta);
    guest.forget(1);
    assert!(!guest.remap(1, &control).meta);
}

#[test]
fn stops_remapping_when_the_key_is_released_and_ignores_a_bad_table() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command"}));
    remap_down(&guest, "ControlRight", "control");
    guest.remap(
        1,
        &GuestKeyInput {
            kind: "keyUp".to_owned(),
            code: "ControlRight".to_owned(),
            key: "Control".to_owned(),
            ..key()
        },
    );
    assert!(!guest.remap(1, &key()).meta);
    guest.set(&json!("garbage"));
    remap_down(&guest, "ControlRight", "control");
    assert!(
        !guest
            .remap(
                1,
                &GuestKeyInput {
                    control: true,
                    ..key()
                }
            )
            .remapped
    );
}

#[test]
fn ignores_an_event_it_injected_no_tracking_no_second_remap() {
    let (guest, inject) = create_with(|_| false);
    guest.set(&json!({"ControlLeft": "command", "MetaLeft": "control"}));
    remap_down(&guest, "ControlLeft", "control");
    inject.inject_into(1, || {
        let injected = GuestKeyInput {
            code: "MetaLeft".to_owned(),
            key: "Meta".to_owned(),
            meta: true,
            ..key()
        };
        assert_eq!(guest.remap(1, &injected), injected);
        assert_eq!(guest.rewrite(1, &injected), None);
    });
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                control: true,
                ..key()
            }
        ),
        Some(vec![event("keyDown", "K", &["meta"])])
    );
}

#[test]
fn has_nothing_to_send_with_the_default_table_or_an_unchanged_key() {
    let guest = create();
    let meta = GuestKeyInput {
        meta: true,
        ..key()
    };
    assert_eq!(guest.rewrite(1, &meta), None);
    guest.set(&json!({"ControlRight": "command"}));
    assert_eq!(guest.rewrite(1, &meta), None);
}

#[test]
fn sends_the_key_with_the_remapped_modifiers_and_keeps_shift_and_repeat() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command", "AltLeft": "control"}));
    remap_down(&guest, "ControlRight", "control");
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                control: true,
                shift: true,
                is_auto_repeat: true,
                ..key()
            }
        ),
        Some(vec![event(
            "keyDown",
            "K",
            &["shift", "meta", "isautorepeat"]
        )])
    );
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                kind: "keyUp".to_owned(),
                control: true,
                ..key()
            }
        ),
        Some(vec![event("keyUp", "K", &["meta"])])
    );
}

#[test]
fn takes_option_characters_away_from_a_key_remapped_to_command() {
    let guest = create();
    guest.set(&json!({"AltLeft": "command"}));
    remap_down(&guest, "AltLeft", "alt");
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                key: "˚".to_owned(),
                alt: true,
                ..key()
            }
        ),
        Some(vec![event("keyDown", "K", &["meta"])])
    );
}

#[test]
fn sends_the_modifier_press_and_release_as_the_key_it_now_stands_for() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command"}));
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                code: "ControlRight".to_owned(),
                key: "Control".to_owned(),
                control: true,
                ..key()
            }
        ),
        Some(vec![event("keyDown", "Meta", &["meta"])])
    );
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                kind: "keyUp".to_owned(),
                code: "ControlRight".to_owned(),
                key: "Control".to_owned(),
                ..key()
            }
        ),
        Some(vec![event("keyUp", "Meta", &[])])
    );
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                code: "ControlLeft".to_owned(),
                key: "Control".to_owned(),
                control: true,
                ..key()
            }
        ),
        None
    );
}

#[test]
fn passes_composition_dead_keys_and_keys_it_cannot_name_through() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command"}));
    remap_down(&guest, "ControlRight", "control");
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                control: true,
                is_composing: true,
                ..key()
            }
        ),
        None
    );
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                control: true,
                key: "Dead".to_owned(),
                ..key()
            }
        ),
        None
    );
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                control: true,
                code: "Numpad1".to_owned(),
                ..key()
            }
        ),
        None
    );
}

#[test]
fn keeps_the_physical_key_for_a_native_menu_shortcut() {
    let (guest, _) = create_with(|input| input.meta);
    guest.set(&json!({"MetaLeft": "control"}));
    remap_down(&guest, "MetaLeft", "meta");
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                meta: true,
                ..key()
            }
        ),
        None
    );
}

#[test]
fn tracks_a_modifier_pressed_while_composing() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command"}));
    guest.rewrite(
        1,
        &GuestKeyInput {
            code: "ControlRight".to_owned(),
            key: "Control".to_owned(),
            control: true,
            is_composing: true,
            ..key()
        },
    );
    let events = guest
        .rewrite(
            1,
            &GuestKeyInput {
                control: true,
                ..key()
            },
        )
        .unwrap();
    assert_eq!(events[0].modifiers, vec!["meta".to_owned()]);
}

#[test]
fn names_a_letter_by_the_character_the_layout_typed_not_by_its_us_position() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command"}));
    remap_down(&guest, "ControlRight", "control");
    for (code, typed, expected) in [("KeyC", "j", "J"), ("KeyQ", "a", "A")] {
        let events = guest
            .rewrite(
                1,
                &GuestKeyInput {
                    control: true,
                    code: code.to_owned(),
                    key: typed.to_owned(),
                    ..key()
                },
            )
            .unwrap();
        assert_eq!(events[0].key_code, expected, "{code} {typed}");
    }
}

#[test]
fn types_the_plain_character_for_a_key_remapped_to_option_and_for_nothing_else() {
    let guest = create();
    guest.set(&json!({"ControlRight": "option", "MetaRight": "control"}));
    remap_down(&guest, "ControlRight", "control");
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                control: true,
                ..key()
            }
        ),
        Some(vec![
            event("keyDown", "K", &["alt"]),
            event("char", "k", &["alt"]),
        ])
    );
    assert_eq!(
        guest
            .rewrite(
                1,
                &GuestKeyInput {
                    kind: "keyUp".to_owned(),
                    control: true,
                    ..key()
                }
            )
            .unwrap()
            .len(),
        1
    );
    guest.rewrite(
        1,
        &GuestKeyInput {
            kind: "keyUp".to_owned(),
            code: "ControlRight".to_owned(),
            key: "Control".to_owned(),
            ..key()
        },
    );
    remap_down(&guest, "MetaRight", "meta");
    assert_eq!(
        guest
            .rewrite(
                1,
                &GuestKeyInput {
                    meta: true,
                    ..key()
                }
            )
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn forgets_a_held_key_whose_modifier_the_system_no_longer_reports() {
    let guest = create();
    guest.set(&json!({"ControlRight": "command"}));
    remap_down(&guest, "ControlRight", "control");
    guest.remap(
        1,
        &GuestKeyInput {
            kind: "keyUp".to_owned(),
            control: false,
            ..key()
        },
    );
    assert_eq!(
        guest.rewrite(
            1,
            &GuestKeyInput {
                control: true,
                ..key()
            }
        ),
        None
    );
}
