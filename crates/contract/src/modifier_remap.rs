use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RemapKey {
    ControlLeft,
    ControlRight,
    AltLeft,
    AltRight,
    MetaLeft,
    MetaRight,
}

const REMAP_KEYS: [RemapKey; 6] = [
    RemapKey::ControlLeft,
    RemapKey::ControlRight,
    RemapKey::AltLeft,
    RemapKey::AltRight,
    RemapKey::MetaLeft,
    RemapKey::MetaRight,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemapTarget {
    Control,
    Option,
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModifierFlags {
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

#[derive(Debug, Clone, Copy)]
enum Family {
    Ctrl,
    Alt,
    Meta,
}

const FAMILIES: [Family; 3] = [Family::Ctrl, Family::Alt, Family::Meta];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModifierRemap(BTreeMap<RemapKey, RemapTarget>);

impl ModifierRemap {
    pub fn new() -> Self {
        Self::default()
    }
}

impl<const N: usize> From<[(RemapKey, RemapTarget); N]> for ModifierRemap {
    fn from(entries: [(RemapKey, RemapTarget); N]) -> Self {
        Self(entries.into_iter().collect())
    }
}

impl RemapKey {
    fn code(self) -> &'static str {
        match self {
            Self::ControlLeft => "ControlLeft",
            Self::ControlRight => "ControlRight",
            Self::AltLeft => "AltLeft",
            Self::AltRight => "AltRight",
            Self::MetaLeft => "MetaLeft",
            Self::MetaRight => "MetaRight",
        }
    }

    fn from_code(code: &str) -> Option<Self> {
        REMAP_KEYS.into_iter().find(|key| key.code() == code)
    }

    fn default_target(self) -> RemapTarget {
        match self {
            Self::ControlLeft | Self::ControlRight => RemapTarget::Control,
            Self::AltLeft | Self::AltRight => RemapTarget::Option,
            Self::MetaLeft | Self::MetaRight => RemapTarget::Command,
        }
    }

    fn family(self) -> Family {
        match self {
            Self::ControlLeft | Self::ControlRight => Family::Ctrl,
            Self::AltLeft | Self::AltRight => Family::Alt,
            Self::MetaLeft | Self::MetaRight => Family::Meta,
        }
    }
}

impl RemapTarget {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "control" => Some(Self::Control),
            "option" => Some(Self::Option),
            "command" => Some(Self::Command),
            _ => None,
        }
    }

    fn key_name(self) -> &'static str {
        match self {
            Self::Control => "Control",
            Self::Option => "Alt",
            Self::Command => "Meta",
        }
    }

    fn family(self) -> Family {
        match self {
            Self::Control => Family::Ctrl,
            Self::Option => Family::Alt,
            Self::Command => Family::Meta,
        }
    }
}

impl Family {
    fn keys(self) -> [RemapKey; 2] {
        match self {
            Self::Ctrl => [RemapKey::ControlLeft, RemapKey::ControlRight],
            Self::Alt => [RemapKey::AltLeft, RemapKey::AltRight],
            Self::Meta => [RemapKey::MetaLeft, RemapKey::MetaRight],
        }
    }

    fn is_set(self, flags: ModifierFlags) -> bool {
        match self {
            Self::Ctrl => flags.ctrl,
            Self::Alt => flags.alt,
            Self::Meta => flags.meta,
        }
    }

    fn set(self, flags: &mut ModifierFlags) {
        match self {
            Self::Ctrl => flags.ctrl = true,
            Self::Alt => flags.alt = true,
            Self::Meta => flags.meta = true,
        }
    }
}

pub fn parse_modifier_remap(raw: &Value) -> ModifierRemap {
    let Some(source) = raw.as_object() else {
        return ModifierRemap::new();
    };
    ModifierRemap(
        REMAP_KEYS
            .into_iter()
            .filter_map(|key| {
                let target = RemapTarget::from_name(source.get(key.code())?.as_str()?)?;
                (target != key.default_target()).then_some((key, target))
            })
            .collect(),
    )
}

pub fn remap_target(table: &ModifierRemap, key: RemapKey) -> RemapTarget {
    table
        .0
        .get(&key)
        .copied()
        .unwrap_or_else(|| key.default_target())
}

pub fn is_identity_remap(table: &ModifierRemap) -> bool {
    REMAP_KEYS
        .into_iter()
        .all(|key| remap_target(table, key) == key.default_target())
}

pub fn track_modifier_key(down: &mut BTreeSet<RemapKey>, code: &str, pressed: bool) {
    let Some(key) = RemapKey::from_code(code) else {
        return;
    };
    if pressed {
        down.insert(key);
    } else {
        down.remove(&key);
    }
}

pub fn release_stale(down: &mut BTreeSet<RemapKey>, real: ModifierFlags) {
    down.retain(|key| key.family().is_set(real));
}

pub fn remapped_flags(
    table: &ModifierRemap,
    down: &BTreeSet<RemapKey>,
    real: ModifierFlags,
) -> ModifierFlags {
    let mut out = ModifierFlags {
        ctrl: false,
        alt: false,
        meta: false,
    };
    for family in FAMILIES {
        if !family.is_set(real) {
            continue;
        }
        let held: Vec<RemapKey> = family
            .keys()
            .into_iter()
            .filter(|key| down.contains(key))
            .collect();
        if held.is_empty() {
            family.set(&mut out);
        }
        for key in held {
            remap_target(table, key).family().set(&mut out);
        }
    }
    out
}

pub fn is_retargeted(table: &ModifierRemap, code: &str) -> bool {
    RemapKey::from_code(code).is_some_and(|key| remap_target(table, key) != key.default_target())
}

pub fn remapped_modifier_key(table: &ModifierRemap, code: &str) -> Option<&'static str> {
    RemapKey::from_code(code).map(|key| remap_target(table, key).key_name())
}

pub fn same_flags(a: ModifierFlags, b: ModifierFlags) -> bool {
    a == b
}
