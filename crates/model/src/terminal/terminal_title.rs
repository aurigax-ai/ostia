use ostia_base::js::{js_trim, utf16_len};

pub const TERMINAL_TITLE_MAX: usize = 120;

pub fn terminal_title(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|ch| !ch.is_control()).collect();
    let title = js_trim(&cleaned);
    if title.is_empty() {
        return None;
    }
    if utf16_len(title) <= TERMINAL_TITLE_MAX {
        return Some(title.to_owned());
    }
    let mut capped = String::new();
    let mut units = 0;
    for ch in title.chars() {
        units += ch.len_utf16();
        if units > TERMINAL_TITLE_MAX - 1 {
            break;
        }
        capped.push(ch);
    }
    capped.push('…');
    Some(capped)
}
