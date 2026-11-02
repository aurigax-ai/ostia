use ostia_base::js::{is_js_space, js_trim, utf16_len};

use crate::hidden_text::{code_escape, is_control, is_hidden_format};

const TAB: u32 = 9;
const LF: u32 = 10;

fn without_controls(text: &str, keep_layout: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let code = u32::from(ch);
        if is_hidden_format(code) {
            out.push_str(&code_escape(code));
        } else if !is_control(code) {
            out.push(ch);
        } else if code == LF || code == TAB {
            out.push(if keep_layout { ch } else { ' ' });
        }
    }
    out
}

pub fn clip_to(text: &str, max: usize) -> String {
    if utf16_len(text) <= max {
        return text.to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().take(max.saturating_sub(1)).collect();
    format!("{}…", String::from_utf16_lossy(&units))
}

pub fn one_line(raw: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in without_controls(raw, false).chars() {
        if is_js_space(ch) {
            gap = true;
        } else {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(ch);
        }
    }
    out
}

pub fn plain_block(raw: &str) -> String {
    let unified = raw.replace("\r\n", "\n").replace('\r', "\n");
    js_trim(&without_controls(&unified, true)).to_owned()
}
