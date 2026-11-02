use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use ostia_contract::modifier_remap::{
    ModifierFlags, ModifierRemap, RemapKey, is_identity_remap, is_retargeted, parse_modifier_remap,
    release_stale, remapped_flags, remapped_modifier_key, same_flags, track_modifier_key,
};
use parking_lot::Mutex;
use serde_json::Value;

use crate::guest_inject::GuestInject;
use crate::guest_key::GuestKeyInput;
use crate::guest_key_event::{KeyboardInputEvent, guest_key_events, guest_key_name};

type NativeMenuKey = Arc<dyn Fn(&GuestKeyInput) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct GuestRemap {
    inject: GuestInject,
    native_menu_key: NativeMenuKey,
    table: Arc<Mutex<ModifierRemap>>,
    held: Arc<Mutex<HashMap<u32, BTreeSet<RemapKey>>>>,
}

impl GuestRemap {
    pub fn new(
        inject: GuestInject,
        native_menu_key: impl Fn(&GuestKeyInput) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            inject,
            native_menu_key: Arc::new(native_menu_key),
            table: Arc::new(Mutex::new(ModifierRemap::new())),
            held: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn set(&self, raw: &Value) {
        *self.table.lock() = parse_modifier_remap(raw);
    }

    pub fn forget(&self, guest_id: u32) {
        self.held.lock().remove(&guest_id);
    }

    pub fn remap(&self, guest_id: u32, input: &GuestKeyInput) -> GuestKeyInput {
        self.remapped(guest_id, input)
            .unwrap_or_else(|| input.clone())
    }

    fn remapped(&self, guest_id: u32, input: &GuestKeyInput) -> Option<GuestKeyInput> {
        if self.inject.is_injecting(guest_id) {
            return None;
        }
        let pressed = match input.kind.as_str() {
            "keyDown" => true,
            "keyUp" => false,
            _ => return None,
        };
        let table = self.table.lock().clone();
        let real = ModifierFlags {
            ctrl: input.control,
            alt: input.alt,
            meta: input.meta,
        };
        let next = {
            let mut held = self.held.lock();
            let down = held.entry(guest_id).or_default();
            track_modifier_key(down, &input.code, pressed);
            release_stale(down, real);
            if is_identity_remap(&table) {
                return None;
            }
            remapped_flags(&table, down, real)
        };
        if same_flags(real, next) {
            return None;
        }
        Some(GuestKeyInput {
            control: next.ctrl,
            alt: next.alt,
            meta: next.meta,
            remapped: true,
            ..input.clone()
        })
    }

    pub fn rewrite(&self, guest_id: u32, input: &GuestKeyInput) -> Option<Vec<KeyboardInputEvent>> {
        if self.inject.is_injecting(guest_id) {
            return None;
        }
        let changed = self.remapped(guest_id, input);
        if input.is_composing || input.key == "Dead" {
            return None;
        }
        let table = self.table.lock().clone();
        let retargeted = is_retargeted(&table, &input.code);
        if changed.is_none() && !retargeted {
            return None;
        }
        if (self.native_menu_key)(input) {
            return None;
        }
        let mapped = changed.as_ref().unwrap_or(input);
        let flags = ModifierFlags {
            ctrl: mapped.control,
            alt: mapped.alt,
            meta: mapped.meta,
        };
        let key_code = match remapped_modifier_key(&table, &input.code) {
            Some(name) => Some(name.to_owned()),
            None => guest_key_name(&input.code, &input.key, input.alt),
        };
        let key_code = key_code.filter(|name| !name.is_empty())?;
        Some(guest_key_events(input, &key_code, flags))
    }
}
