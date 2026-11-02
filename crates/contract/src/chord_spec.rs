use std::collections::BTreeMap;
use std::sync::LazyLock;

use ostia_base::js::js_trim;
use serde_json::Value;

use crate::proto_guard::is_dangerous_segment;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChordSpec {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub key: String,
    pub terminal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyLike {
    pub key: String,
    pub code: String,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    pub alt: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChordValue {
    One(String),
    Many(Vec<String>),
}

pub type KeybindingMap = BTreeMap<String, Option<ChordValue>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChordProblem {
    Invalid,
    Escape,
    Tab,
    Bare,
    NeedsModifier,
    CtrlKey,
    Arrow,
    DigitRange,
}

impl ChordProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::Escape => "escape",
            Self::Tab => "tab",
            Self::Bare => "bare",
            Self::NeedsModifier => "needs-modifier",
            Self::CtrlKey => "ctrl-key",
            Self::Arrow => "arrow",
            Self::DigitRange => "digit-range",
        }
    }
}

pub const CHORDS_PER_COMMAND_MAX: usize = 8;
pub const DIGIT_RANGE: &str = "1-9";
pub const DOUBLE_SHIFT: &str = "Shift+Shift";
pub const TERMINAL_SCOPE: &str = "terminal:";
pub const WORKSPACE_GOTO: &str = "workspace.goto";
pub const PALETTE_TOGGLE: &str = "palette.toggle";

const DOUBLE_SHIFT_MS: u64 = 300;

pub const BROWSER_CHORD_IDS: [&str; 4] = [
    "browser.focusAddress",
    "browser.reload",
    "browser.back",
    "browser.forward",
];

pub const TERMINAL_COMMAND_CHORD_IDS: [&str; 9] = [
    "terminal.scrollToTop",
    "terminal.scrollToBottom",
    "terminal.scrollPageUp",
    "terminal.scrollPageDown",
    "terminal.scrollLineUp",
    "terminal.scrollLineDown",
    "terminal.reviewOutput",
    "tab.moveLeft",
    "tab.moveRight",
];

pub const TERMINAL_CHORD_IDS: [&str; 16] = [
    "copy",
    "paste",
    "find",
    "find.next",
    "find.previous",
    "block.selectPrev",
    "block.selectNext",
    "terminal.scrollToTop",
    "terminal.scrollToBottom",
    "terminal.scrollPageUp",
    "terminal.scrollPageDown",
    "terminal.scrollLineUp",
    "terminal.scrollLineDown",
    "terminal.reviewOutput",
    "tab.moveLeft",
    "tab.moveRight",
];

const MODIFIER_KEYS: [&str; 8] = [
    "Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "Hyper", "Super",
];

pub static DOUBLE_SHIFT_KEY: LazyLock<KeyLike> = LazyLock::new(|| KeyLike {
    key: "Shift".to_owned(),
    code: "ShiftLeft".to_owned(),
    ctrl: false,
    meta: false,
    shift: true,
    alt: false,
});

pub fn chord_texts(value: &ChordValue) -> Vec<String> {
    match value {
        ChordValue::One(text) => vec![text.clone()],
        ChordValue::Many(texts) => texts.clone(),
    }
}

fn named_key(lower: &str) -> Option<&'static str> {
    Some(match lower {
        "up" | "arrowup" | "↑" => "up",
        "down" | "arrowdown" | "↓" => "down",
        "left" | "arrowleft" | "←" => "left",
        "right" | "arrowright" | "→" => "right",
        "space" | " " => "space",
        "enter" | "return" => "enter",
        "tab" => "tab",
        "escape" | "esc" => "escape",
        "backspace" => "backspace",
        "delete" | "del" => "delete",
        "home" => "home",
        "end" => "end",
        "pageup" => "pageup",
        "pagedown" => "pagedown",
        "insert" => "insert",
        "shift" => "shift",
        DIGIT_RANGE => DIGIT_RANGE,
        _ => return None,
    })
}

fn code_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "Semicolon" => ";",
        "Quote" => "'",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Backslash" => "\\",
        "Minus" => "-",
        "Equal" => "=",
        "Backquote" => "`",
        "Space" => "space",
        "Enter" | "NumpadEnter" => "enter",
        "Tab" => "tab",
        "Escape" => "escape",
        "Backspace" => "backspace",
        "Delete" => "delete",
        "Home" => "home",
        "End" => "end",
        "PageUp" => "pageup",
        "PageDown" => "pagedown",
        "Insert" => "insert",
        "ArrowUp" => "up",
        "ArrowDown" => "down",
        "ArrowLeft" => "left",
        "ArrowRight" => "right",
        _ => return None,
    })
}

fn key_title(key: &str) -> Option<&'static str> {
    Some(match key {
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "space" => "Space",
        "enter" => "Enter",
        "tab" => "Tab",
        "escape" => "Escape",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "insert" => "Insert",
        "shift" => "Shift",
        _ => return None,
    })
}

fn arrow_glyph(key: &str) -> Option<&'static str> {
    Some(match key {
        "up" => "↑",
        "down" => "↓",
        "left" => "←",
        "right" => "→",
        _ => return None,
    })
}

fn is_arrow(key: &str) -> bool {
    arrow_glyph(key).is_some()
}

fn is_ctrl_safe_key(key: &str) -> bool {
    matches!(
        key,
        "," | "." | ";" | "'" | "=" | "pageup" | "pagedown" | DIGIT_RANGE
    )
}

fn is_punctuation(raw: &str) -> bool {
    matches!(
        raw,
        "," | "." | "/" | ";" | "'" | "[" | "]" | "\\" | "-" | "=" | "`"
    )
}

fn is_single(text: &str, accepts: impl Fn(char) -> bool) -> bool {
    let mut chars = text.chars();
    matches!((chars.next(), chars.next()), (Some(ch), None) if accepts(ch))
}

fn is_function_number(digits: &str) -> bool {
    matches!(
        digits.as_bytes(),
        [b'1'..=b'9'] | [b'1', b'0'..=b'9'] | [b'2', b'0'..=b'4']
    )
}

fn is_function_digits(digits: &str) -> bool {
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn normalize_key(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    if let Some(named) = named_key(&lower) {
        return Some(named.to_owned());
    }
    if is_single(&lower, |ch| ch.is_ascii_lowercase() || ch.is_ascii_digit()) {
        return Some(lower);
    }
    if lower.strip_prefix('f').is_some_and(is_function_number) {
        return Some(lower);
    }
    if is_punctuation(raw) {
        return Some(raw.to_owned());
    }
    None
}

fn set_modifier(spec: &mut ChordSpec, name: &str, mac: bool) -> Option<()> {
    let flag = match name.to_lowercase().as_str() {
        "ctrl" | "control" => &mut spec.ctrl,
        "shift" => &mut spec.shift,
        "alt" | "option" | "opt" => &mut spec.alt,
        "cmd" | "command" | "meta" | "super" => &mut spec.meta,
        "mod" => {
            if mac {
                &mut spec.meta
            } else {
                &mut spec.ctrl
            }
        }
        _ => return None,
    };
    if *flag {
        return None;
    }
    *flag = true;
    Some(())
}

pub fn parse_chord(text: &str, mac: bool) -> Option<ChordSpec> {
    let mut parts: Vec<&str> = text.split('+').map(js_trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let raw_key = parts.pop()?;
    let mut spec = ChordSpec {
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
        key: String::new(),
        terminal: false,
    };
    for part in parts {
        set_modifier(&mut spec, part, mac)?;
    }
    spec.key = normalize_key(raw_key)?;
    if spec.key == "shift" && !is_double_shift(&spec) {
        return None;
    }
    Some(spec)
}

pub fn is_double_shift(spec: &ChordSpec) -> bool {
    spec.key == "shift" && spec.shift && !spec.ctrl && !spec.alt && !spec.meta
}

pub fn is_double_shift_key(event: &KeyLike) -> bool {
    event.key == "Shift"
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TapKey {
    pub key: String,
    pub ctrl: bool,
    pub meta: bool,
    pub alt: bool,
    pub repeat: bool,
    pub is_composing: bool,
}

#[derive(Debug, Default)]
pub struct DoubleShiftDetector {
    down_at: Option<u64>,
    tapped_at: Option<u64>,
    armed: bool,
}

impl DoubleShiftDetector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn down(&mut self, event: &TapKey, now: u64) {
        let lone = event.key == "Shift" && !event.ctrl && !event.meta && !event.alt;
        if !lone || event.repeat || event.is_composing {
            self.reset();
            return;
        }
        self.armed = self
            .tapped_at
            .is_some_and(|tapped| now.saturating_sub(tapped) <= DOUBLE_SHIFT_MS);
        self.tapped_at = None;
        self.down_at = Some(now);
    }

    pub fn up(&mut self, event: &TapKey, now: u64) -> bool {
        if event.key != "Shift" {
            return false;
        }
        let tap = self
            .down_at
            .is_some_and(|down| now.saturating_sub(down) <= DOUBLE_SHIFT_MS);
        let second = self.armed;
        self.reset();
        if !tap {
            return false;
        }
        if second {
            return true;
        }
        self.tapped_at = Some(now);
        false
    }

    pub fn reset(&mut self) {
        self.down_at = None;
        self.tapped_at = None;
        self.armed = false;
    }
}

fn meta_name(mac: bool) -> &'static str {
    if mac { "Cmd" } else { "Super" }
}

fn title_of(key: &str) -> String {
    if let Some(title) = key_title(key) {
        return title.to_owned();
    }
    let is_letter = is_single(key, |ch| ch.is_ascii_lowercase());
    let is_function = key.strip_prefix('f').is_some_and(is_function_digits);
    if is_letter || is_function {
        key.to_uppercase()
    } else {
        key.to_owned()
    }
}

pub fn format_chord(spec: &ChordSpec, mac: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    if spec.ctrl {
        parts.push("Ctrl".to_owned());
    }
    if spec.shift {
        parts.push("Shift".to_owned());
    }
    if spec.alt {
        parts.push("Alt".to_owned());
    }
    if spec.meta {
        parts.push(meta_name(mac).to_owned());
    }
    parts.push(title_of(&spec.key));
    parts.join("+")
}

pub fn chord_text(spec: &ChordSpec, mac: bool) -> String {
    let key = arrow_glyph(&spec.key).map_or_else(|| title_of(&spec.key), str::to_owned);
    if !mac {
        let mut parts: Vec<&str> = Vec::new();
        if spec.ctrl {
            parts.push("Ctrl");
        }
        if spec.shift {
            parts.push("Shift");
        }
        if spec.alt {
            parts.push("Alt");
        }
        if spec.meta {
            parts.push("Super");
        }
        parts.push(&key);
        return parts.join("+");
    }
    if is_double_shift(spec) {
        return "⇧⇧".to_owned();
    }
    format!(
        "{}{}{}{}{key}",
        if spec.ctrl { "⌃" } else { "" },
        if spec.alt { "⌥" } else { "" },
        if spec.meta { "⌘" } else { "" },
        if spec.shift { "⇧" } else { "" },
    )
}

pub fn same_chord(a: &ChordSpec, b: &ChordSpec) -> bool {
    a.ctrl == b.ctrl && a.shift == b.shift && a.alt == b.alt && a.meta == b.meta && a.key == b.key
}

pub fn overlaps(a: &ChordSpec, b: &ChordSpec) -> bool {
    if same_chord(a, b) {
        return true;
    }
    let same_modifiers =
        a.ctrl == b.ctrl && a.shift == b.shift && a.alt == b.alt && a.meta == b.meta;
    if !same_modifiers {
        return false;
    }
    let is_digit = |key: &str| is_single(key, |ch| ('1'..='9').contains(&ch));
    (a.key == DIGIT_RANGE && is_digit(&b.key)) || (b.key == DIGIT_RANGE && is_digit(&a.key))
}

fn event_key(event: &KeyLike) -> Option<String> {
    let lower = event.key.to_lowercase();
    if is_single(&lower, |ch| ch.is_ascii_lowercase()) {
        return Some(lower);
    }
    let code = event.code.as_str();
    if let Some(letter) = code
        .strip_prefix("Key")
        .filter(|rest| matches!(rest.as_bytes(), [b'A'..=b'Z']))
    {
        return Some(letter.to_lowercase());
    }
    if let Some(digit) = code
        .strip_prefix("Digit")
        .or_else(|| code.strip_prefix("Numpad"))
        .filter(|rest| matches!(rest.as_bytes(), [b'0'..=b'9']))
    {
        return Some(digit.to_owned());
    }
    if code.strip_prefix('F').is_some_and(is_function_number) {
        return Some(code.to_lowercase());
    }
    if let Some(key) = code_key(code) {
        return Some(key.to_owned());
    }
    normalize_key(&event.key)
}

pub fn spec_from_event(event: &KeyLike) -> Option<ChordSpec> {
    if MODIFIER_KEYS.contains(&event.key.as_str()) {
        return None;
    }
    Some(ChordSpec {
        ctrl: event.ctrl,
        shift: event.shift,
        alt: event.alt,
        meta: event.meta,
        key: event_key(event)?,
        terminal: false,
    })
}

pub fn steals_terminal_key(spec: &ChordSpec, mac: bool) -> Option<ChordProblem> {
    if spec.key == "escape" {
        return Some(ChordProblem::Escape);
    }
    if spec.key == "tab" {
        return if spec.ctrl && !spec.alt && !spec.meta {
            None
        } else {
            Some(ChordProblem::Tab)
        };
    }
    if !spec.ctrl && !spec.shift && !spec.alt && !spec.meta {
        return Some(ChordProblem::Bare);
    }
    if mac {
        return if spec.meta {
            None
        } else {
            Some(ChordProblem::NeedsModifier)
        };
    }
    if !spec.ctrl && !spec.meta {
        return Some(ChordProblem::NeedsModifier);
    }
    let ctrl_only = spec.ctrl && !spec.shift && !spec.alt && !spec.meta;
    if !ctrl_only {
        return None;
    }
    if is_arrow(&spec.key) {
        return Some(ChordProblem::Arrow);
    }
    let is_digit = is_single(&spec.key, |ch| ch.is_ascii_digit());
    let is_function = spec.key.strip_prefix('f').is_some_and(is_function_digits);
    if is_digit || is_function || is_ctrl_safe_key(&spec.key) {
        return None;
    }
    Some(ChordProblem::CtrlKey)
}

fn is_browser_id(id: &str) -> bool {
    BROWSER_CHORD_IDS.contains(&id)
}

fn is_terminal_id(id: &str) -> bool {
    TERMINAL_CHORD_IDS.contains(&id)
}

fn not_shell_owned(spec: &ChordSpec) -> bool {
    spec.key != "escape" && spec.key != "tab"
}

fn alt_chord(spec: &ChordSpec) -> bool {
    spec.alt && !spec.ctrl && !spec.meta && not_shell_owned(spec)
}

fn ctrl_chord(spec: &ChordSpec) -> bool {
    spec.ctrl && !spec.alt && !spec.shift && !spec.meta && not_shell_owned(spec)
}

pub fn is_palette_f1(id: &str, spec: &ChordSpec) -> bool {
    let bare = !spec.ctrl && !spec.shift && !spec.alt && !spec.meta && !spec.terminal;
    id == PALETTE_TOGGLE && spec.key == "f1" && bare
}

pub fn binding_problem(id: &str, spec: &ChordSpec, mac: bool) -> Option<ChordProblem> {
    if is_palette_f1(id, spec) {
        return None;
    }
    if is_double_shift(spec) {
        return (spec.terminal || is_browser_id(id) || is_terminal_id(id))
            .then_some(ChordProblem::Invalid);
    }
    let browser_only = is_browser_id(id) && (alt_chord(spec) || ctrl_chord(spec));
    let steal = if browser_only {
        None
    } else {
        steals_terminal_key(spec, mac)
    };
    if steal.is_some() {
        return steal;
    }
    let is_range = spec.key == DIGIT_RANGE;
    if is_range == (id == WORKSPACE_GOTO) {
        None
    } else {
        Some(ChordProblem::DigitRange)
    }
}

pub fn parse_scoped_chord(text: &str, mac: bool) -> Option<ChordSpec> {
    let trimmed = js_trim(text);
    let terminal = trimmed.to_lowercase().starts_with(TERMINAL_SCOPE);
    let body = if terminal {
        trimmed.get(TERMINAL_SCOPE.len()..)?
    } else {
        trimmed
    };
    let spec = parse_chord(body, mac)?;
    Some(ChordSpec { terminal, ..spec })
}

pub fn format_scoped_chord(spec: &ChordSpec, mac: bool) -> String {
    let scope = if spec.terminal { TERMINAL_SCOPE } else { "" };
    format!("{scope}{}", format_chord(spec, mac))
}

pub fn same_scope(a: &ChordSpec, b: &ChordSpec) -> bool {
    a.terminal == b.terminal
}

pub fn check_binding(id: &str, text: &str, mac: bool) -> Option<ChordProblem> {
    match parse_scoped_chord(text, mac) {
        Some(spec) => binding_problem(id, &spec, mac),
        None => Some(ChordProblem::Invalid),
    }
}

fn monaco_other_texts() -> Vec<String> {
    let mut texts: Vec<String> = "ACGIKLMORZ"
        .chars()
        .map(|key| format!("Ctrl+Shift+{key}"))
        .collect();
    texts.extend(
        [
            "Ctrl+Shift+[",
            "Ctrl+Shift+]",
            "Ctrl+Shift+\\",
            "Ctrl+Shift+Space",
            "Ctrl+Shift+Enter",
            "Ctrl+Enter",
            "Ctrl+Alt+Up",
            "Ctrl+Alt+Down",
            "Ctrl+F2",
            "Ctrl+F12",
            "Ctrl+Shift+F12",
        ]
        .map(str::to_owned),
    );
    texts
}

fn monaco_mac_texts() -> Vec<String> {
    let mut texts: Vec<String> = "ACDFGLSVXZ/[]"
        .chars()
        .map(|key| format!("Cmd+{key}"))
        .collect();
    texts.extend("KLZG[]\\".chars().map(|key| format!("Shift+Cmd+{key}")));
    texts.extend(
        [
            "Alt+Cmd+F",
            "Cmd+Enter",
            "Shift+Cmd+Enter",
            "Alt+Cmd+Up",
            "Alt+Cmd+Down",
            "Cmd+F2",
            "Cmd+F12",
        ]
        .map(str::to_owned),
    );
    texts
}

fn parse_all(texts: Vec<String>, mac: bool) -> Vec<ChordSpec> {
    texts
        .iter()
        .filter_map(|text| parse_chord(text, mac))
        .collect()
}

static MONACO_OTHER: LazyLock<Vec<ChordSpec>> =
    LazyLock::new(|| parse_all(monaco_other_texts(), false));

static MONACO_MAC: LazyLock<Vec<ChordSpec>> = LazyLock::new(|| parse_all(monaco_mac_texts(), true));

pub fn used_by_monaco(spec: &ChordSpec, mac: bool) -> bool {
    let defaults: &[ChordSpec] = if mac { &MONACO_MAC } else { &MONACO_OTHER };
    defaults.iter().any(|known| same_chord(known, spec))
}

fn parses_somewhere(text: &str) -> bool {
    parse_scoped_chord(text, true).is_some() || parse_scoped_chord(text, false).is_some()
}

fn parse_chord_value(value: &Value) -> Option<ChordValue> {
    match value {
        Value::String(text) => {
            parses_somewhere(text).then(|| ChordValue::One(js_trim(text).to_owned()))
        }
        Value::Array(items) => {
            let mut unique: Vec<String> = Vec::new();
            for text in items
                .iter()
                .filter_map(Value::as_str)
                .filter(|text| parses_somewhere(text))
                .map(js_trim)
            {
                if !unique.iter().any(|known| known == text) {
                    unique.push(text.to_owned());
                }
            }
            unique.truncate(CHORDS_PER_COMMAND_MAX);
            (!unique.is_empty()).then_some(ChordValue::Many(unique))
        }
        _ => None,
    }
}

pub fn parse_keybindings(raw: &Value) -> KeybindingMap {
    let mut out = KeybindingMap::new();
    let Some(entries) = raw.as_object() else {
        return out;
    };
    for (id, value) in entries {
        if id.is_empty() || is_dangerous_segment(id) {
            continue;
        }
        if value.is_null() {
            out.insert(id.clone(), None);
            continue;
        }
        if let Some(chords) = parse_chord_value(value) {
            out.insert(id.clone(), Some(chords));
        }
    }
    out
}

pub fn is_native_clipboard_key(event: &KeyLike) -> bool {
    spec_from_event(event).is_some_and(|spec| {
        spec.meta && !spec.ctrl && !spec.alt && !spec.shift && (spec.key == "c" || spec.key == "v")
    })
}
