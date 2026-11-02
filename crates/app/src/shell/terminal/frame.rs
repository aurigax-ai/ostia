#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub fn packed(self) -> u32 {
        (u32::from(self.r) << 16) | (u32::from(self.g) << 8) | u32::from(self.b)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub col: u16,
    pub cells: u16,
    pub text: String,
    pub fg: Rgb,
    pub bg: Option<Rgb>,
    pub bold: bool,
    pub underline: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub col: u16,
    pub row: u16,
}

#[derive(Clone, Debug)]
pub struct Frame {
    pub lines: Vec<Vec<Span>>,
    pub cursor: Option<Cursor>,
    pub background: Rgb,
    pub foreground: Rgb,
    pub cursor_color: Rgb,
}

impl Frame {
    pub fn blank(background: Rgb, foreground: Rgb, cursor_color: Rgb) -> Self {
        Self {
            lines: Vec::new(),
            cursor: None,
            background,
            foreground,
            cursor_color,
        }
    }
}
