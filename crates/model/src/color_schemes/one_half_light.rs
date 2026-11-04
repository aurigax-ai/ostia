use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn one_half_light() -> ColorScheme {
    ColorScheme {
        id: "one-half-light".to_owned(),
        name: "One Half Light".to_owned(),
        appearance: Appearance::Light,
        colors: TerminalColors {
            background: "#fafafa",
            foreground: "#383a42",
            cursor: "#a5b4e5",
            cursor_accent: "#383a42",
            selection_background: "#bfceff",
            selection_foreground: Some("#383a42"),
            black: "#383a42",
            red: "#e45649",
            green: "#50a14f",
            yellow: "#c18401",
            blue: "#0184bc",
            magenta: "#a626a4",
            cyan: "#0997b3",
            white: "#bababa",
            bright_black: "#4f525e",
            bright_red: "#e06c75",
            bright_green: "#98c379",
            bright_yellow: "#d8b36e",
            bright_blue: "#61afef",
            bright_magenta: "#c678dd",
            bright_cyan: "#56b6c2",
            bright_white: "#ffffff",
        },
    }
}
