#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ostia_browser::guest_chords::{
    ChordGuest, ChordHost, GuardedGuest, GuestChords, GuestChordsDeps,
};
use ostia_browser::guest_inject::GuestInject;
use ostia_browser::guest_key::GuestKeyInput;
use ostia_browser::guest_key_event::KeyboardInputEvent;
use ostia_browser::guest_remap::GuestRemap;
use ostia_contract::chord_spec::KeyLike;
use ostia_contract::guest_chords::GuestChordFire;
use parking_lot::Mutex;
use serde_json::{Value, json};

const APP: u32 = 1;
const STRANGER: u32 = 2;
const GUEST_ID: u32 = 9;

#[derive(Default)]
struct FakeHost {
    destroyed: AtomicBool,
    fired: Mutex<Vec<GuestChordFire>>,
}

impl ChordHost for FakeHost {
    fn is_destroyed(&self) -> bool {
        self.destroyed.load(Ordering::SeqCst)
    }

    fn send_chord_fire(&self, fire: GuestChordFire) {
        self.fired.lock().push(fire);
    }
}

type Reentry = Box<dyn Fn(&KeyboardInputEvent) + Send + Sync>;

struct FakeGuest {
    host: Mutex<Option<Arc<FakeHost>>>,
    sent: Mutex<Vec<KeyboardInputEvent>>,
    reentry: Mutex<Option<Reentry>>,
}

impl ChordGuest for FakeGuest {
    fn id(&self) -> u32 {
        GUEST_ID
    }

    fn host(&self) -> Option<Arc<dyn ChordHost>> {
        self.host
            .lock()
            .clone()
            .map(|host| host as Arc<dyn ChordHost>)
    }

    fn send_input_event(&self, event: KeyboardInputEvent) {
        self.sent.lock().push(event.clone());
        let reentry = self.reentry.lock().take();
        if let Some(reentry) = reentry {
            reentry(&event);
            *self.reentry.lock() = Some(reentry);
        }
    }
}

struct Setup {
    host: Arc<FakeHost>,
    guest: Arc<FakeGuest>,
    chords: GuestChords,
    guarded: Arc<GuardedGuest>,
}

fn setup(mac: bool, human_browser: bool, owns_find: bool) -> Setup {
    let inject = GuestInject::new();
    let host = Arc::new(FakeHost::default());
    let guest = Arc::new(FakeGuest {
        host: Mutex::new(Some(host.clone())),
        sent: Mutex::new(Vec::new()),
        reentry: Mutex::new(None),
    });
    let chords = GuestChords::new(GuestChordsDeps {
        is_app_window: Box::new(|sender| sender == APP),
        mac,
        inject: inject.clone(),
        remap: GuestRemap::new(inject, |input: &GuestKeyInput| {
            input.key == "q" && input.meta
        }),
        is_human_browser: Box::new(move |_| human_browser),
        viewer_owns_find_keys: Box::new(move |_| owns_find),
    });
    let guarded = chords.guard_guest(guest.clone());
    Setup {
        host,
        guest,
        chords,
        guarded,
    }
}

fn ctrl_shift_p() -> GuestKeyInput {
    GuestKeyInput {
        kind: "keyDown".to_owned(),
        key: "p".to_owned(),
        code: "KeyP".to_owned(),
        control: true,
        shift: true,
        alt: false,
        meta: false,
        ..GuestKeyInput::default()
    }
}

fn key(name: &str, code: &str) -> GuestKeyInput {
    GuestKeyInput {
        key: name.to_owned(),
        code: code.to_owned(),
        ..ctrl_shift_p()
    }
}

fn plain(name: &str, code: &str, control: bool, shift: bool) -> GuestKeyInput {
    GuestKeyInput {
        control,
        shift,
        ..key(name, code)
    }
}

fn key_up(input: GuestKeyInput) -> GuestKeyInput {
    GuestKeyInput {
        kind: "keyUp".to_owned(),
        ..input
    }
}

impl Setup {
    fn set(&self, sender: u32, raw: Value) {
        self.chords.set_chords(sender, &raw);
    }

    fn remap(&self, sender: u32, raw: Value) {
        self.chords.set_remap(sender, &raw);
    }

    fn press(&self, input: GuestKeyInput) -> bool {
        self.guarded.before_input_event(&input, 0)
    }

    fn fired(&self) -> Vec<GuestChordFire> {
        self.host.fired.lock().clone()
    }

    fn sent(&self) -> Vec<KeyboardInputEvent> {
        self.guest.sent.lock().clone()
    }
}

fn like(key: &str, code: &str, ctrl: bool, shift: bool, alt: bool, meta: bool) -> KeyLike {
    KeyLike {
        key: key.to_owned(),
        code: code.to_owned(),
        ctrl,
        meta,
        shift,
        alt,
    }
}

fn fire(key: KeyLike) -> GuestChordFire {
    GuestChordFire {
        guest_id: GUEST_ID,
        key,
    }
}

fn event(kind: &str, key_code: &str, modifiers: &[&str]) -> KeyboardInputEvent {
    KeyboardInputEvent {
        kind: kind.to_owned(),
        key_code: key_code.to_owned(),
        modifiers: modifiers.iter().map(|m| (*m).to_owned()).collect(),
    }
}

#[test]
fn sends_a_bound_chord_to_the_host_window_instead_of_the_page() {
    let s = setup(false, true, false);
    s.set(APP, json!(["Ctrl+Shift+P"]));
    assert!(s.press(ctrl_shift_p()));
    assert_eq!(
        s.fired(),
        [fire(like("p", "KeyP", true, true, false, false))]
    );
}

#[test]
fn leaves_the_find_keys_to_a_viewer_page_that_owns_find_and_still_forwards_its_other_app_chords() {
    let s = setup(false, true, true);
    s.set(APP, json!(["Ctrl+F", "Ctrl+G", "Ctrl+Shift+P"]));
    assert!(!s.press(plain("f", "KeyF", true, false)));
    assert!(!s.press(plain("g", "KeyG", true, true)));
    assert!(s.fired().is_empty());
    assert!(s.press(ctrl_shift_p()));
    assert_eq!(s.fired().len(), 1);
}

#[test]
fn forwards_the_find_keys_of_a_viewer_page_that_did_not_claim_them_like_any_other_guest() {
    let s = setup(false, true, false);
    s.set(APP, json!(["Ctrl+F", "Ctrl+G"]));
    assert!(s.press(plain("f", "KeyF", true, false)));
    assert!(s.press(plain("g", "KeyG", true, false)));
    assert_eq!(s.fired().len(), 2);
}

#[test]
fn forwards_the_find_keys_of_any_other_guest_to_the_host_window() {
    let s = setup(false, true, false);
    s.set(APP, json!(["Ctrl+F"]));
    assert!(s.press(plain("f", "KeyF", true, false)));
    assert_eq!(s.fired().len(), 1);
}

#[test]
fn lets_other_keys_reach_the_page() {
    let s = setup(false, true, false);
    s.set(APP, json!(["Ctrl+Shift+P"]));
    assert!(!s.press(key("q", "KeyQ")));
    assert!(!s.press(key_up(ctrl_shift_p())));
    assert!(s.fired().is_empty());
}

#[test]
fn takes_the_chord_list_only_from_an_app_window_and_only_when_it_is_valid() {
    let s = setup(false, true, false);
    s.set(STRANGER, json!(["Ctrl+Shift+P"]));
    assert!(!s.press(ctrl_shift_p()));
    s.set(APP, json!(["Ctrl+Shift+P"]));
    s.set(APP, json!("garbage"));
    assert!(s.press(ctrl_shift_p()));
}

#[test]
fn tells_the_host_about_two_quick_shift_taps_without_holding_the_keys_back_from_the_page() {
    let s = setup(true, true, false);
    s.set(APP, json!(["Shift+Shift"]));
    let shift = |kind: &str| GuestKeyInput {
        kind: kind.to_owned(),
        control: false,
        ..key("Shift", "ShiftLeft")
    };
    let mut prevented = Vec::new();
    for at in [0_u64, 150] {
        prevented.push(s.guarded.before_input_event(&shift("keyDown"), at));
        prevented.push(s.guarded.before_input_event(&shift("keyUp"), at + 50));
    }
    assert_eq!(prevented, [false, false, false, false]);
    assert_eq!(
        s.fired(),
        [fire(like("Shift", "ShiftLeft", false, true, false, false))]
    );
}

#[test]
fn does_nothing_when_the_host_window_is_gone() {
    let s = setup(false, true, false);
    s.set(APP, json!(["Ctrl+Shift+P"]));
    *s.guest.host.lock() = None;
    assert!(!s.press(ctrl_shift_p()));
}

#[test]
fn does_nothing_when_the_host_window_is_destroyed() {
    let s = setup(false, true, false);
    s.set(APP, json!(["Ctrl+Shift+P"]));
    s.host.destroyed.store(true, Ordering::SeqCst);
    assert!(!s.press(ctrl_shift_p()));
    assert!(s.fired().is_empty());
}

#[test]
fn matches_a_chord_on_the_keys_the_remap_makes_of_the_held_ones_and_nothing_for_a_stranger() {
    let s = setup(true, true, false);
    s.set(APP, json!(["Cmd+K"]));
    let ctrl_k = plain("k", "KeyK", true, false);
    let hold = plain("Control", "ControlRight", true, false);
    s.remap(STRANGER, json!({"ControlRight": "command"}));
    s.press(hold);
    assert!(!s.press(ctrl_k.clone()));
    s.remap(APP, json!({"ControlRight": "command"}));
    assert!(s.press(ctrl_k));
    assert_eq!(
        s.fired(),
        [fire(like("k", "KeyK", false, false, false, true))]
    );
}

#[test]
fn lets_the_page_keep_a_real_cmd_c_but_treats_a_key_remapped_to_command_as_an_app_chord() {
    let s = setup(true, true, false);
    s.set(APP, json!(["Cmd+C"]));
    let cmd_c = GuestKeyInput {
        meta: true,
        ..plain("c", "KeyC", false, false)
    };
    assert!(!s.press(cmd_c));
    s.remap(APP, json!({"ControlLeft": "command"}));
    s.press(plain("Control", "ControlLeft", true, false));
    assert!(s.press(plain("c", "KeyC", true, false)));
    assert_eq!(s.fired().len(), 1);
}

#[test]
fn matches_cmd_c_for_option_remapped_to_command_although_option_c_types_a_cedilla() {
    let s = setup(true, true, false);
    s.set(APP, json!(["Cmd+C"]));
    s.remap(APP, json!({"AltLeft": "command"}));
    let alt = |name: &str, code: &str| GuestKeyInput {
        alt: true,
        ..plain(name, code, false, false)
    };
    s.press(alt("Alt", "AltLeft"));
    assert!(s.press(alt("ç", "KeyC")));
    assert_eq!(
        s.fired(),
        [fire(like("ç", "KeyC", false, false, false, true))]
    );
}

#[test]
fn cancels_a_physical_key_a_remap_changes_and_sends_the_remapped_one_to_the_page() {
    let s = setup(true, true, false);
    s.remap(APP, json!({"ControlLeft": "command"}));
    assert!(s.press(plain("Control", "ControlLeft", true, false)));
    assert_eq!(s.sent().last(), Some(&event("keyDown", "Meta", &["meta"])));
    assert!(s.press(plain("k", "KeyK", true, false)));
    assert_eq!(s.sent().last(), Some(&event("keyDown", "K", &["meta"])));
}

#[test]
fn leaves_a_key_alone_with_no_remap_set() {
    let s = setup(true, true, false);
    assert!(!s.press(key("k", "KeyK")));
    assert!(s.sent().is_empty());
}

#[test]
fn sends_nothing_to_the_page_off_macos() {
    let s = setup(false, true, false);
    s.remap(APP, json!({"ControlLeft": "command"}));
    s.press(plain("Control", "ControlLeft", true, false));
    assert!(s.sent().is_empty());
}

#[test]
fn leaves_the_keys_of_a_page_that_is_not_the_human_browser_alone() {
    let s = setup(true, false, false);
    s.remap(APP, json!({"ControlLeft": "command"}));
    assert!(!s.press(key("Control", "ControlLeft")));
    assert!(s.sent().is_empty());
}

#[test]
fn does_not_send_a_key_an_app_chord_already_took() {
    let s = setup(true, true, false);
    s.set(APP, json!(["Cmd+K"]));
    s.remap(APP, json!({"ControlLeft": "command"}));
    s.press(plain("Control", "ControlLeft", true, false));
    s.guest.sent.lock().clear();
    s.press(plain("k", "KeyK", true, false));
    assert!(s.sent().is_empty());
}

#[test]
fn does_not_remap_the_event_it_sent_itself_a_second_time() {
    let s = setup(true, true, false);
    s.remap(
        APP,
        json!({"ControlLeft": "command", "MetaLeft": "control"}),
    );
    let guarded = s.guarded.clone();
    *s.guest.reentry.lock() = Some(Box::new(move |sent: &KeyboardInputEvent| {
        let has = |name: &str| sent.modifiers.iter().any(|m| m == name);
        let code = if sent.key_code == "Meta" {
            "MetaLeft"
        } else {
            "KeyK"
        };
        let input = GuestKeyInput {
            kind: sent.kind.clone(),
            key: sent.key_code.to_lowercase(),
            code: code.to_owned(),
            control: has("control"),
            meta: has("meta"),
            ..ctrl_shift_p()
        };
        guarded.before_input_event(&input, 0);
    }));
    s.press(plain("Control", "ControlLeft", true, false));
    s.press(plain("k", "KeyK", true, false));
    assert_eq!(s.sent().len(), 2);
    assert_eq!(s.sent().last(), Some(&event("keyDown", "K", &["meta"])));
}

#[test]
fn forgets_the_held_modifiers_of_a_guest_when_it_is_destroyed() {
    let s = setup(true, true, false);
    s.remap(APP, json!({"ControlLeft": "command"}));
    s.press(plain("Control", "ControlLeft", true, false));
    s.guarded.destroyed();
    s.guest.sent.lock().clear();
    assert!(!s.press(plain("k", "KeyK", true, false)));
    assert!(s.sent().is_empty());
}
