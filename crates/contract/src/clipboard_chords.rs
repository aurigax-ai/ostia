use serde_json::Value;

use crate::chord_spec::{
    ChordSpec, DIGIT_RANGE, KeyLike, format_chord, is_native_clipboard_key, parse_chord,
    same_chord, spec_from_event, steals_terminal_key,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardEdit {
    Copy,
    Paste,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardChords {
    pub copy: Option<ChordSpec>,
    pub paste: Option<ChordSpec>,
}

pub const NO_CLIPBOARD_CHORDS: ClipboardChords = ClipboardChords {
    copy: None,
    paste: None,
};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GuestKeyInput {
    pub kind: String,
    pub key: String,
    pub code: String,
    pub control: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub is_auto_repeat: bool,
    pub is_composing: bool,
    pub remapped: bool,
}

fn normalize_spec(raw: Option<&Value>, mac: bool) -> Option<Option<ChordSpec>> {
    let object = match raw? {
        Value::Null => return Some(None),
        Value::Object(object) => object,
        _ => return None,
    };
    let flag = |name: &str| object.get(name).and_then(Value::as_bool);
    let key = object.get("key")?.as_str()?;
    let spec = ChordSpec {
        ctrl: flag("ctrl")?,
        shift: flag("shift")?,
        alt: flag("alt")?,
        meta: flag("meta")?,
        key: key.to_owned(),
        terminal: false,
    };
    if spec.key == DIGIT_RANGE {
        return None;
    }
    let parsed = parse_chord(&format_chord(&spec, mac), mac)?;
    if !same_chord(&parsed, &spec) || steals_terminal_key(&spec, mac).is_some() {
        return None;
    }
    Some(Some(spec))
}

pub fn normalize_clipboard_chords(raw: &Value, mac: bool) -> Option<ClipboardChords> {
    let object = raw.as_object()?;
    Some(ClipboardChords {
        copy: normalize_spec(object.get("copy"), mac)?,
        paste: normalize_spec(object.get("paste"), mac)?,
    })
}

pub fn is_plain_copy_key(input: &GuestKeyInput, mac: bool) -> bool {
    if input.kind != "keyDown" || input.shift || input.alt || input.is_composing {
        return false;
    }
    let modifier = if mac {
        input.meta && !input.control
    } else {
        input.control && !input.meta
    };
    modifier && (input.code == "KeyC" || input.key.to_lowercase() == "c")
}

pub fn guest_clipboard_edit(
    input: &GuestKeyInput,
    chords: &ClipboardChords,
    mac: bool,
) -> Option<ClipboardEdit> {
    if input.kind != "keyDown" {
        return None;
    }
    let event = KeyLike {
        key: input.key.clone(),
        code: input.code.clone(),
        ctrl: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt,
    };
    if mac && !input.remapped && is_native_clipboard_key(&event) {
        return None;
    }
    let spec = spec_from_event(&event)?;
    if chords
        .copy
        .as_ref()
        .is_some_and(|copy| same_chord(copy, &spec))
    {
        return Some(ClipboardEdit::Copy);
    }
    if chords
        .paste
        .as_ref()
        .is_some_and(|paste| same_chord(paste, &spec))
    {
        return Some(ClipboardEdit::Paste);
    }
    None
}
