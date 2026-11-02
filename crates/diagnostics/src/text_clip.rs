use ostia_base::js::utf16_len;

fn is_kept_char(ch: char) -> bool {
    let code = u32::from(ch);
    code == 9 || code == 10 || (code >= 32 && code != 127)
}

pub fn clip_printable(text: &str, max: usize) -> String {
    let clean: String = text.chars().filter(|ch| is_kept_char(*ch)).collect();
    if utf16_len(&clean) <= max {
        return clean;
    }
    let units: Vec<u16> = clean.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}
