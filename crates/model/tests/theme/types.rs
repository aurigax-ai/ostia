#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::theme::types::{ANSI_NAMES, Appearance};

#[test]
fn ansi_names_lists_the_16_colors_in_order() {
    assert_eq!(
        ANSI_NAMES,
        [
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
        ]
    );
}

#[test]
fn ansi_names_are_unique() {
    let mut names = ANSI_NAMES.to_vec();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), 16);
}

#[test]
fn appearance_is_dark_or_light_in_lowercase() {
    assert_eq!(serde_json::to_string(&Appearance::Dark).unwrap(), "\"dark\"");
    assert_eq!(serde_json::to_string(&Appearance::Light).unwrap(), "\"light\"");
    assert_eq!(
        serde_json::from_str::<Appearance>("\"dark\"").unwrap(),
        Appearance::Dark
    );
    assert_eq!(
        serde_json::from_str::<Appearance>("\"light\"").unwrap(),
        Appearance::Light
    );
    assert!(serde_json::from_str::<Appearance>("\"auto\"").is_err());
}
