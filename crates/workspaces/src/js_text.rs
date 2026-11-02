pub fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in text.char_indices() {
        count += ch.len_utf16();
        if count > units {
            return &text[..index];
        }
    }
    text
}

pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}
