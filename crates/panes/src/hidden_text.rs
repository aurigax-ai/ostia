pub fn is_hidden_format(code: u32) -> bool {
    code == 0x061c || (0x2028..=0x202e).contains(&code) || (0x2066..=0x2069).contains(&code)
}
