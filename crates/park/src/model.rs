use ostia_base::js::is_js_space;

pub const PARKED_PANEL_EXTENSION_ID: &str = "activity";
pub const PARK_SUMMARY_MAX: usize = 160;
pub const PARKED_PER_WORKSPACE_MAX: usize = 25;

pub fn single_line(text: &str, max: usize) -> String {
    let mut one = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        let code = ch as u32;
        let ch = if code < 0x20 || code == 0x7f { ' ' } else { ch };
        if is_js_space(ch) {
            pending_space = !one.is_empty();
        } else {
            if pending_space {
                one.push(' ');
                pending_space = false;
            }
            one.push(ch);
        }
    }
    if one.chars().count() <= max {
        return one;
    }
    let mut cut: String = one.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}
