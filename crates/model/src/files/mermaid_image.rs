use std::fmt;

use ostia_base::js::utf16_len;

pub const MERMAID_SOURCE_MAX: usize = 50_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MermaidSourceTooLarge;

impl fmt::Display for MermaidSourceTooLarge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the diagram is too large to draw")
    }
}

impl std::error::Error for MermaidSourceTooLarge {}

pub fn check_mermaid_source(code: &str) -> Result<(), MermaidSourceTooLarge> {
    if utf16_len(code) > MERMAID_SOURCE_MAX {
        return Err(MermaidSourceTooLarge);
    }
    Ok(())
}
