use crate::theme::types::{Appearance, ColorScheme, TerminalColors};

pub(super) fn github_light() -> ColorScheme {
    ColorScheme {
        id: "github-light".to_owned(),
        name: "GitHub Light".to_owned(),
        appearance: Appearance::Light,
        colors: TerminalColors {
            background: "#ffffff",
            foreground: "#1f2328",
            cursor: "#0969da",
            cursor_accent: "#3c9cff",
            selection_background: "#1f2328",
            selection_foreground: Some("#ffffff"),
            black: "#24292f",
            red: "#cf222e",
            green: "#116329",
            yellow: "#4d2d00",
            blue: "#0969da",
            magenta: "#8250df",
            cyan: "#1b7c83",
            white: "#6e7781",
            bright_black: "#57606a",
            bright_red: "#a40e26",
            bright_green: "#1a7f37",
            bright_yellow: "#633c01",
            bright_blue: "#218bff",
            bright_magenta: "#a475f9",
            bright_cyan: "#3192aa",
            bright_white: "#8c959f",
        },
    }
}
