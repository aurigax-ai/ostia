use serde::{Deserialize, Serialize};

pub const ANSI_NAMES: [&str; 16] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Dark,
    Light,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColors {
    pub background: &'static str,
    pub foreground: &'static str,
    pub cursor: &'static str,
    pub cursor_accent: &'static str,
    pub selection_background: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_foreground: Option<&'static str>,
    pub black: &'static str,
    pub red: &'static str,
    pub green: &'static str,
    pub yellow: &'static str,
    pub blue: &'static str,
    pub magenta: &'static str,
    pub cyan: &'static str,
    pub white: &'static str,
    pub bright_black: &'static str,
    pub bright_red: &'static str,
    pub bright_green: &'static str,
    pub bright_yellow: &'static str,
    pub bright_blue: &'static str,
    pub bright_magenta: &'static str,
    pub bright_cyan: &'static str,
    pub bright_white: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColorScheme {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub colors: TerminalColors,
}
