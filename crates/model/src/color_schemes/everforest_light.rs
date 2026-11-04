use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn everforest_light() -> ColorScheme {
    ColorScheme {
        id: "everforest-light".to_owned(),
        name: "Everforest Light".to_owned(),
        appearance: Appearance::Light,
        colors: TerminalColors {
            background: "#efebd4",
            foreground: "#5c6a72",
            cursor: "#f57d26",
            cursor_accent: "#eaedc8",
            selection_background: "#eaedc8",
            selection_foreground: Some("#5c6a72"),
            black: "#7a8478",
            red: "#e67e80",
            green: "#9ab373",
            yellow: "#c1a266",
            blue: "#7fbbb3",
            magenta: "#d699b6",
            cyan: "#83c092",
            white: "#b2af9f",
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
