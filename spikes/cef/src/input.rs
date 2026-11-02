use cef::{ImplBrowser, ImplBrowserHost, KeyEvent, KeyEventType, MouseButtonType, MouseEvent};
use gpui_kit::{Keystroke, Modifiers, MouseButton};

const SHIFT: u32 = 1 << 1;
const CONTROL: u32 = 1 << 2;
const ALT: u32 = 1 << 3;
const LEFT_BUTTON: u32 = 1 << 4;
const MIDDLE_BUTTON: u32 = 1 << 5;
const RIGHT_BUTTON: u32 = 1 << 6;

pub fn modifier_flags(modifiers: Modifiers, pressed: Option<MouseButton>) -> u32 {
    let mut flags = 0;
    if modifiers.shift {
        flags |= SHIFT;
    }
    if modifiers.control {
        flags |= CONTROL;
    }
    if modifiers.alt {
        flags |= ALT;
    }
    flags
        | match pressed {
            Some(MouseButton::Left) => LEFT_BUTTON,
            Some(MouseButton::Middle) => MIDDLE_BUTTON,
            Some(MouseButton::Right) => RIGHT_BUTTON,
            _ => 0,
        }
}

pub fn mouse_event(x: f32, y: f32, flags: u32) -> MouseEvent {
    MouseEvent {
        x: x as i32,
        y: y as i32,
        modifiers: flags,
    }
}

fn button_type(button: MouseButton) -> Option<MouseButtonType> {
    match button {
        MouseButton::Left => Some(MouseButtonType::LEFT),
        MouseButton::Middle => Some(MouseButtonType::MIDDLE),
        MouseButton::Right => Some(MouseButtonType::RIGHT),
        _ => None,
    }
}

pub fn send_click(
    browser: &cef::Browser,
    button: MouseButton,
    event: &MouseEvent,
    up: bool,
    count: usize,
) {
    let (Some(host), Some(kind)) = (browser.host(), button_type(button)) else {
        return;
    };
    host.send_mouse_click_event(Some(event), kind, up as _, count as _);
}

pub fn send_move(browser: &cef::Browser, event: &MouseEvent, leave: bool) {
    if let Some(host) = browser.host() {
        host.send_mouse_move_event(Some(event), leave as _);
    }
}

pub fn send_wheel(browser: &cef::Browser, event: &MouseEvent, dx: f32, dy: f32) {
    if let Some(host) = browser.host() {
        host.send_mouse_wheel_event(Some(event), dx as i32, dy as i32);
    }
}

fn windows_key_code(key: &str) -> i32 {
    match key {
        "enter" => 13,
        "backspace" => 8,
        "tab" => 9,
        "escape" => 27,
        "space" => 32,
        "left" => 37,
        "up" => 38,
        "right" => 39,
        "down" => 40,
        "delete" => 46,
        "home" => 36,
        "end" => 35,
        "pageup" => 33,
        "pagedown" => 34,
        other => other
            .chars()
            .next()
            .filter(|_| other.chars().count() == 1)
            .map(|c| c.to_ascii_uppercase() as i32)
            .unwrap_or(0),
    }
}

pub fn send_key_down(browser: &cef::Browser, keystroke: &Keystroke) {
    let Some(host) = browser.host() else {
        return;
    };
    let flags = modifier_flags(keystroke.modifiers, None);
    let code = windows_key_code(&keystroke.key);
    host.send_key_event(Some(&KeyEvent {
        type_: KeyEventType::RAWKEYDOWN,
        modifiers: flags,
        windows_key_code: code,
        native_key_code: code,
        ..Default::default()
    }));
    let character = match keystroke.key.as_str() {
        "enter" => Some(13u16),
        "tab" => Some(9),
        "space" => Some(32),
        _ => keystroke
            .key_char
            .as_deref()
            .and_then(|text| text.encode_utf16().next()),
    };
    if let Some(character) = character {
        host.send_key_event(Some(&KeyEvent {
            type_: KeyEventType::CHAR,
            modifiers: flags,
            windows_key_code: character as i32,
            native_key_code: character as i32,
            character,
            unmodified_character: character,
            ..Default::default()
        }));
    }
}

pub fn send_key_up(browser: &cef::Browser, keystroke: &Keystroke) {
    let Some(host) = browser.host() else {
        return;
    };
    let code = windows_key_code(&keystroke.key);
    host.send_key_event(Some(&KeyEvent {
        type_: KeyEventType::KEYUP,
        modifiers: modifier_flags(keystroke.modifiers, None),
        windows_key_code: code,
        native_key_code: code,
        ..Default::default()
    }));
}
