use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn everforest_dark() -> ColorScheme {
    ColorScheme {
        id: "everforest-dark".to_owned(),
        name: "Everforest Dark".to_owned(),
        appearance: Appearance::Dark,
        colors: TerminalColors {
            background: "#1e2326",
            foreground: "#d3c6aa",
            cursor: "#e69875",
            cursor_accent: "#4c3743",
            selection_background: "#4c3743",
            selection_foreground: Some("#d3c6aa"),
            black: "#7a8478",
            red: "#e67e80",
            green: "#a7c080",
            yellow: "#dbbc7f",
            blue: "#7fbbb3",
            magenta: "#d699b6",
            cyan: "#83c092",
            white: "#f2efdf",
            bright_black: "#a6b0a0",
            bright_red: "#f85552",
            bright_green: "#8da101",
            bright_yellow: "#dfa000",
            bright_blue: "#3a94c5",
            bright_magenta: "#df69ba",
            bright_cyan: "#35a77c",
            bright_white: "#fffbef",
        },
    }
}
