#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::Cell;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_workspaces::global_hotkey::{
    GlobalHotkey, HotkeyStatus, ShortcutCallback, ShortcutRegistry, ToggleTray, ToggleWindow,
    should_hide_windows, toggle_windows,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

#[derive(Default)]
struct Registry {
    taken: Vec<String>,
    live: Mutex<Vec<(String, ShortcutCallback)>>,
    registered: Mutex<Vec<String>>,
    unregistered: Mutex<Vec<String>>,
}

impl Registry {
    fn with_taken(taken: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            taken: taken.iter().map(|s| (*s).to_owned()).collect(),
            ..Self::default()
        })
    }

    fn keys(&self) -> Vec<String> {
        self.live
            .lock()
            .iter()
            .map(|(key, _)| key.clone())
            .collect()
    }

    fn fire(&self, accelerator: &str) {
        let callback = self
            .live
            .lock()
            .iter()
            .find(|(key, _)| key == accelerator)
            .map(|(_, callback)| Arc::clone(callback));
        callback.unwrap()();
    }
}

impl ShortcutRegistry for Registry {
    fn register(&self, accelerator: &str, callback: ShortcutCallback) -> bool {
        self.registered.lock().push(accelerator.to_owned());
        if self.taken.iter().any(|t| t == accelerator) {
            return false;
        }
        self.live.lock().push((accelerator.to_owned(), callback));
        true
    }

    fn unregister(&self, accelerator: &str) {
        self.unregistered.lock().push(accelerator.to_owned());
        self.live.lock().retain(|(key, _)| key != accelerator);
    }
}

fn hotkey(registry: &Arc<Registry>) -> GlobalHotkey {
    GlobalHotkey::new(
        Arc::clone(registry) as Arc<dyn ShortcutRegistry>,
        Arc::new(|| {}),
    )
}

fn apply(hotkey: &mut GlobalHotkey, setting: &str) -> HotkeyStatus {
    hotkey.apply(&json!(setting))
}

#[test]
fn registers_the_chosen_chord_as_an_accelerator_and_runs_the_toggle_on_it() {
    let registry = Registry::with_taken(&[]);
    let toggled = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&toggled);
    let mut hotkey = GlobalHotkey::new(
        Arc::clone(&registry) as Arc<dyn ShortcutRegistry>,
        Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
    );
    assert_eq!(
        apply(&mut hotkey, "ctrl+alt+space"),
        HotkeyStatus::Registered
    );
    assert_eq!(registry.keys(), ["Ctrl+Alt+Space"]);
    registry.fire("Ctrl+Alt+Space");
    assert_eq!(toggled.load(Ordering::SeqCst), 1);
}

#[test]
fn swaps_the_old_chord_for_a_new_one_keeps_one_it_already_holds_and_clears_on_empty() {
    let registry = Registry::with_taken(&[]);
    let mut hotkey = hotkey(&registry);
    apply(&mut hotkey, "Ctrl+Alt+P");
    apply(&mut hotkey, "Ctrl+Alt+P");
    assert_eq!(registry.registered.lock().len(), 1);
    apply(&mut hotkey, "Super+F12");
    assert_eq!(registry.keys(), ["Super+F12"]);
    assert_eq!(apply(&mut hotkey, ""), HotkeyStatus::Off);
    assert!(registry.keys().is_empty());
}

#[test]
fn refuses_a_key_without_a_modifier_or_with_shift_alone_and_reports_a_chord_in_use() {
    let registry = Registry::with_taken(&["Ctrl+Alt+T"]);
    let mut hotkey = hotkey(&registry);
    assert_eq!(apply(&mut hotkey, "F1"), HotkeyStatus::Off);
    assert_eq!(apply(&mut hotkey, "Shift+A"), HotkeyStatus::Off);
    assert_eq!(apply(&mut hotkey, "Ctrl+Bogus"), HotkeyStatus::Off);
    assert_eq!(hotkey.apply(&json!(42)), HotkeyStatus::Off);
    assert_eq!(apply(&mut hotkey, "Ctrl+Alt+T"), HotkeyStatus::Taken);
    assert_eq!(registry.registered.lock().len(), 1);
}

#[test]
fn workspaces_global_hotkey_registers_a_system_wide_shortcut_and_drops_it_when_cleared() {
    let registry = Registry::with_taken(&[]);
    let mut hotkey = hotkey(&registry);
    assert_eq!(apply(&mut hotkey, "Ctrl+Alt+F9"), HotkeyStatus::Registered);
    assert_eq!(*registry.registered.lock(), ["Ctrl+Alt+F9"]);
    assert_eq!(registry.keys(), ["Ctrl+Alt+F9"]);
    assert_eq!(apply(&mut hotkey, ""), HotkeyStatus::Off);
    assert_eq!(*registry.unregistered.lock(), ["Ctrl+Alt+F9"]);
    assert!(registry.keys().is_empty());
}

#[test]
fn a_taken_chord_leaves_nothing_registered_and_the_old_chord_is_released_first() {
    let registry = Registry::with_taken(&["Ctrl+Alt+T"]);
    let mut hotkey = hotkey(&registry);
    apply(&mut hotkey, "Ctrl+Alt+P");
    assert_eq!(apply(&mut hotkey, "Ctrl+Alt+T"), HotkeyStatus::Taken);
    assert!(registry.keys().is_empty());
    assert_eq!(*registry.unregistered.lock(), ["Ctrl+Alt+P"]);
    assert_eq!(apply(&mut hotkey, "Ctrl+Alt+T"), HotkeyStatus::Taken);
    assert_eq!(registry.registered.lock().len(), 3);
}

#[test]
fn clear_releases_the_chord_it_holds_and_does_nothing_when_it_holds_none() {
    let registry = Registry::with_taken(&[]);
    let mut hotkey = hotkey(&registry);
    hotkey.clear();
    assert!(registry.unregistered.lock().is_empty());
    apply(&mut hotkey, "Ctrl+Alt+P");
    hotkey.clear();
    assert_eq!(*registry.unregistered.lock(), ["Ctrl+Alt+P"]);
    assert!(registry.keys().is_empty());
    assert_eq!(hotkey.apply(&Value::Null), HotkeyStatus::Off);
}

struct Win {
    shown: Cell<bool>,
    focused: Cell<bool>,
    destroyed: bool,
}

impl Win {
    fn new(visible: bool, focused: bool) -> Self {
        Self {
            shown: Cell::new(visible),
            focused: Cell::new(focused),
            destroyed: false,
        }
    }
}

impl ToggleWindow for Win {
    fn is_visible(&self) -> bool {
        self.shown.get()
    }

    fn is_focused(&self) -> bool {
        self.focused.get()
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed
    }
}

#[test]
fn hides_only_when_a_visible_window_has_focus_otherwise_the_hotkey_brings_them_up() {
    assert!(should_hide_windows(&[
        Win::new(true, true),
        Win::new(true, false)
    ]));
    assert!(!should_hide_windows(&[Win::new(true, false)]));
    assert!(!should_hide_windows(&[Win::new(false, false)]));
    assert!(!should_hide_windows::<Win>(&[]));
}

#[test]
fn a_destroyed_window_never_counts_as_focused() {
    let mut gone = Win::new(true, true);
    gone.destroyed = true;
    assert!(!should_hide_windows(&[gone]));
}

struct Tray {
    hidden: Cell<usize>,
}

impl ToggleTray<Win> for Tray {
    fn hide(&self, win: &Win) {
        self.hidden.set(self.hidden.get() + 1);
        win.shown.set(false);
        win.focused.set(false);
    }
}

fn windows(count: usize) -> Vec<Win> {
    (0..count).map(|_| Win::new(true, true)).collect()
}

#[test]
fn hides_the_focused_windows_to_the_tray_then_reveals_them_then_hides_them_again() {
    let list = windows(2);
    let tray = Tray {
        hidden: Cell::new(0),
    };
    let revealed = Cell::new(0);
    let reveal = || {
        revealed.set(revealed.get() + 1);
        for win in &list {
            win.shown.set(true);
            win.focused.set(true);
        }
    };
    toggle_windows(&list, Some(&tray), reveal);
    assert_eq!(tray.hidden.get(), 2);
    assert_eq!(
        list.iter().map(|w| w.shown.get()).collect::<Vec<_>>(),
        [false, false]
    );
    toggle_windows(&list, Some(&tray), reveal);
    assert_eq!(revealed.get(), 1);
    assert_eq!(
        list.iter().map(|w| w.shown.get()).collect::<Vec<_>>(),
        [true, true]
    );
    toggle_windows(&list, Some(&tray), reveal);
    assert_eq!(tray.hidden.get(), 4);
}

#[test]
fn reveals_when_there_is_no_tray_or_no_window_is_focused() {
    let revealed = Cell::new(0);
    let reveal = || revealed.set(revealed.get() + 1);
    let tray = Tray {
        hidden: Cell::new(0),
    };
    toggle_windows::<Win>(&windows(1), None, reveal);
    let unfocused = vec![Win::new(false, false)];
    toggle_windows(&unfocused, Some(&tray), reveal);
    assert_eq!(revealed.get(), 2);
    assert_eq!(tray.hidden.get(), 0);
}

#[test]
fn hides_every_visible_window_but_skips_destroyed_and_already_hidden_ones() {
    let mut gone = Win::new(true, false);
    gone.destroyed = true;
    let list = vec![Win::new(true, true), gone, Win::new(false, false)];
    let tray = Tray {
        hidden: Cell::new(0),
    };
    toggle_windows(&list, Some(&tray), || panic!("must not reveal"));
    assert_eq!(tray.hidden.get(), 1);
}
