pub fn line_reference(path: &str, start_line: u32, end_line: u32) -> String {
    if start_line == end_line {
        format!("{path}:{start_line}")
    } else {
        format!("{path}:{start_line}-{end_line}")
    }
}
