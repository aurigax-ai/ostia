#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalPosition {
    pub x: i64,
    pub y: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalRange {
    pub start: TerminalPosition,
    pub end: TerminalPosition,
}
