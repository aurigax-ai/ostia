use std::collections::HashSet;
use std::sync::Arc;

use ostia_contract::chord_spec::{
    ChordSpec, DIGIT_RANGE, DOUBLE_SHIFT, DOUBLE_SHIFT_KEY, DoubleShiftDetector, KeyLike, TapKey,
    format_chord, is_native_clipboard_key, parse_chord, spec_from_event,
};
use ostia_contract::guest_chords::GuestChordFire;
use parking_lot::Mutex;
use serde_json::Value;

use crate::guest_inject::GuestInject;
use crate::guest_key::GuestKeyInput;
use crate::guest_key_event::KeyboardInputEvent;
use crate::guest_remap::GuestRemap;

const MAX_GUEST_CHORDS: usize = 512;

pub trait ChordHost: Send + Sync {
    fn is_destroyed(&self) -> bool;
    fn send_chord_fire(&self, fire: GuestChordFire);
}

pub trait ChordGuest: Send + Sync {
    fn id(&self) -> u32;
    fn host(&self) -> Option<Arc<dyn ChordHost>>;
    fn send_input_event(&self, event: KeyboardInputEvent);
}

type SenderCheck = Box<dyn Fn(u32) -> bool + Send + Sync>;
type GuestCheck = Box<dyn Fn(&dyn ChordGuest) -> bool + Send + Sync>;

pub struct GuestChordsDeps {
    pub is_app_window: SenderCheck,
    pub mac: bool,
    pub inject: GuestInject,
    pub remap: GuestRemap,
    pub is_human_browser: GuestCheck,
    pub viewer_owns_find_keys: GuestCheck,
}

struct Shared {
    deps: GuestChordsDeps,
    chords: Mutex<HashSet<String>>,
}

#[derive(Clone)]
pub struct GuestChords {
    shared: Arc<Shared>,
}

pub struct GuardedGuest {
    shared: Arc<Shared>,
    guest: Arc<dyn ChordGuest>,
    detector: Mutex<DoubleShiftDetector>,
    rewrites_keys: bool,
}

pub fn normalize_guest_chords(raw: &Value, mac: bool) -> Option<Vec<String>> {
    let items = raw
        .as_array()
        .filter(|items| items.len() <= MAX_GUEST_CHORDS)?;
    items
        .iter()
        .map(|item| {
            let text = item.as_str()?;
            let spec = parse_chord(text, mac)?;
            (format_chord(&spec, mac) == text).then(|| text.to_owned())
        })
        .collect()
}

fn guest_chord_key(input: &GuestKeyInput, chords: &HashSet<String>, mac: bool) -> Option<KeyLike> {
    if input.kind != "keyDown" || chords.is_empty() {
        return None;
    }
    let key = input.key_like();
    if mac && !input.remapped && is_native_clipboard_key(&key) {
        return None;
    }
    let spec = spec_from_event(&key)?;
    if chords.contains(&format_chord(&spec, mac)) {
        return Some(key);
    }
    let is_digit = matches!(spec.key.as_bytes(), [b'1'..=b'9']);
    let range = ChordSpec {
        key: DIGIT_RANGE.to_owned(),
        ..spec
    };
    (is_digit && chords.contains(&format_chord(&range, mac))).then_some(key)
}

fn is_page_find_key(input: &GuestKeyInput, mac: bool) -> bool {
    if input.kind != "keyDown" || input.alt {
        return false;
    }
    let primary = if mac {
        input.meta && !input.control
    } else {
        input.control && !input.meta
    };
    let key = input.key.to_lowercase();
    if primary {
        return key == "g" || (key == "f" && !input.shift);
    }
    key == "f3" && !input.control && !input.meta
}

fn guest_double_shift(
    input: &GuestKeyInput,
    chords: &HashSet<String>,
    detector: &mut DoubleShiftDetector,
    now: u64,
) -> bool {
    let key = TapKey {
        key: input.key.clone(),
        ctrl: input.control,
        meta: input.meta,
        alt: input.alt,
        repeat: input.is_auto_repeat,
        is_composing: input.is_composing,
    };
    match input.kind.as_str() {
        "keyDown" => {
            detector.down(&key, now);
            false
        }
        "keyUp" => detector.up(&key, now) && chords.contains(DOUBLE_SHIFT),
        _ => false,
    }
}

impl GuestChords {
    pub fn new(deps: GuestChordsDeps) -> Self {
        Self {
            shared: Arc::new(Shared {
                deps,
                chords: Mutex::new(HashSet::new()),
            }),
        }
    }

    pub fn set_chords(&self, sender: u32, raw: &Value) {
        let deps = &self.shared.deps;
        if !(deps.is_app_window)(sender) {
            return;
        }
        if let Some(next) = normalize_guest_chords(raw, deps.mac) {
            *self.shared.chords.lock() = next.into_iter().collect();
        }
    }

    pub fn set_remap(&self, sender: u32, raw: &Value) {
        let deps = &self.shared.deps;
        if (deps.is_app_window)(sender) {
            deps.remap.set(raw);
        }
    }

    pub fn guard_guest(&self, guest: Arc<dyn ChordGuest>) -> Arc<GuardedGuest> {
        let deps = &self.shared.deps;
        let rewrites_keys = deps.mac && (deps.is_human_browser)(guest.as_ref());
        Arc::new(GuardedGuest {
            shared: self.shared.clone(),
            guest,
            detector: Mutex::new(DoubleShiftDetector::new()),
            rewrites_keys,
        })
    }
}

impl GuardedGuest {
    pub fn destroyed(&self) {
        self.shared.deps.remap.forget(self.guest.id());
    }

    pub fn before_input_event(&self, raw: &GuestKeyInput, now: u64) -> bool {
        let prevented = self.fire_chord(raw, now);
        if prevented || !self.rewrites_keys {
            return prevented;
        }
        self.rewrite_key(raw)
    }

    fn fire_chord(&self, raw: &GuestKeyInput, now: u64) -> bool {
        let deps = &self.shared.deps;
        let id = self.guest.id();
        let input = deps.remap.remap(id, raw);
        let tapped = {
            let chords = self.shared.chords.lock();
            let mut detector = self.detector.lock();
            guest_double_shift(&input, &chords, &mut detector, now)
        };
        let page_find =
            is_page_find_key(&input, deps.mac) && (deps.viewer_owns_find_keys)(self.guest.as_ref());
        let key = if tapped {
            Some(DOUBLE_SHIFT_KEY.clone())
        } else if page_find {
            None
        } else {
            guest_chord_key(&input, &self.shared.chords.lock(), deps.mac)
        };
        let Some(key) = key else {
            return false;
        };
        let Some(host) = self.guest.host().filter(|host| !host.is_destroyed()) else {
            return false;
        };
        host.send_chord_fire(GuestChordFire { guest_id: id, key });
        !tapped
    }

    fn rewrite_key(&self, raw: &GuestKeyInput) -> bool {
        let deps = &self.shared.deps;
        let id = self.guest.id();
        let Some(events) = deps.remap.rewrite(id, raw) else {
            return false;
        };
        deps.inject.inject_into(id, || {
            for event in events {
                self.guest.send_input_event(event);
            }
        });
        true
    }
}
