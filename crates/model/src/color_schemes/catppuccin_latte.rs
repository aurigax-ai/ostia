use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn catppuccin_latte() -> ColorScheme {
    ColorScheme {
        id: "catppuccin-latte".to_owned(),
        name: "Catppuccin Latte".to_owned(),
        appearance: Appearance::Light,
        colors: TerminalColors {
            background: "#eff1f5",
            foreground: "#4c4f69",
            cursor: "#dc8a78",
            cursor_accent: "#eff1f5",
            selection_background: "#dc8a78",
            selection_foreground: Some("#eff1f5"),
            black: "#bcc0cc",
            red: "#d20f39",
            green: "#40a02b",
            yellow: "#df8e1d",
            blue: "#1e66f5",
            magenta: "#ea76cb",
            cyan: "#179299",
            white: "#5c5f77",
            bright_black: "#acb0be",
            bright_red: "#e7103f",
            bright_green: "#46b02f",
            bright_yellow: "#e49931",
            bright_blue: "#3878f6",
            bright_magenta: "#ef95d7",
            bright_cyan: "#19a1a8",
            bright_white: "#6c6f85",
        },
    }
}
