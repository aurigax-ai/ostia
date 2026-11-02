const DANGEROUS_SEGMENTS: [&str; 3] = ["__proto__", "prototype", "constructor"];

pub fn is_dangerous_segment(segment: &str) -> bool {
    DANGEROUS_SEGMENTS.contains(&segment)
}
