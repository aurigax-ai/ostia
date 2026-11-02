pub fn is_control(code: u32) -> bool {
    code < 0x20 || code == 0x7f || (0x80..=0x9f).contains(&code)
}

pub fn has_control_character(text: &str) -> bool {
    text.chars().any(|ch| is_control(ch as u32))
}
