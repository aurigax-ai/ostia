use ostia_base::js::js_trim;
use serde_json::Value;

const WAKE_REASON_MAX: usize = 200;

pub fn wake_reason(raw: &Value) -> Option<String> {
    let plain: String = raw
        .as_str()?
        .chars()
        .filter(|ch| {
            let code = u32::from(*ch);
            code >= 0x20 && !(0x7f..=0x9f).contains(&code)
        })
        .collect();
    let trimmed = js_trim(&plain);
    if trimmed.is_empty() {
        return None;
    }
    Some(cap_utf16(trimmed, WAKE_REASON_MAX))
}

fn cap_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= max
        })
        .collect()
}
