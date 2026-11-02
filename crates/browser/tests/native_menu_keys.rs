#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_browser::native_menu_keys::{GuestKeyInput, MenuNode, create_native_menu_key};

fn input(key: &str, code: &str, alt: bool, meta: bool) -> GuestKeyInput {
    GuestKeyInput {
        kind: "keyDown".to_owned(),
        key: key.to_owned(),
        code: code.to_owned(),
        control: false,
        shift: false,
        alt,
        meta,
        ..GuestKeyInput::default()
    }
}

fn q() -> GuestKeyInput {
    input("q", "KeyQ", false, true)
}

fn item(accelerator: &str) -> MenuNode {
    MenuNode {
        accelerator: Some(accelerator.to_owned()),
        ..MenuNode::default()
    }
}

fn menu() -> Vec<MenuNode> {
    vec![MenuNode {
        submenu: Some(vec![
            item("Command+Q"),
            item("CommandOrControl+C"),
            MenuNode {
                register_accelerator: Some(false),
                ..item("Cmd+,")
            },
            MenuNode {
                submenu: Some(vec![item("Alt+Command+I")]),
                ..MenuNode::default()
            },
        ]),
        ..MenuNode::default()
    }]
}

#[test]
fn knows_the_shortcuts_a_menu_item_registers_nested_and_written_either_way() {
    let native_key = create_native_menu_key(menu);
    assert!(native_key(&q()));
    assert!(native_key(&input("c", "KeyC", false, true)));
    assert!(native_key(&input("˚", "KeyI", true, true)));
}

#[test]
fn ignores_an_accelerator_the_menu_only_displays_other_chords_and_bare_modifiers() {
    let native_key = create_native_menu_key(menu);
    assert!(!native_key(&input(",", "Comma", false, true)));
    assert!(!native_key(&input("q", "KeyQ", false, false)));
    assert!(!native_key(&input("Meta", "MetaLeft", false, true)));
}
