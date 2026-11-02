use ostia_contract::chord_spec::{ChordSpec, parse_chord, spec_from_event};

pub use crate::guest_key::GuestKeyInput;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MenuNode {
    pub accelerator: Option<String>,
    pub register_accelerator: Option<bool>,
    pub submenu: Option<Vec<MenuNode>>,
}

fn replace_command_or_control(accelerator: &str) -> String {
    let lower = accelerator.to_ascii_lowercase();
    let first_hit = ["commandorcontrol", "cmdorcontrol"]
        .iter()
        .filter_map(|word| lower.find(word).map(|at| (at, word.len())))
        .min();
    match first_hit {
        Some((at, len)) => format!("{}Cmd{}", &accelerator[..at], &accelerator[at + len..]),
        None => accelerator.to_owned(),
    }
}

fn menu_chords(items: &[MenuNode], out: &mut Vec<ChordSpec>) {
    for item in items {
        if let Some(spec) = item
            .accelerator
            .as_deref()
            .filter(|_| item.register_accelerator != Some(false))
            .and_then(|accelerator| parse_chord(&replace_command_or_control(accelerator), true))
        {
            out.push(spec);
        }
        if let Some(submenu) = &item.submenu {
            menu_chords(submenu, out);
        }
    }
}

pub fn create_native_menu_key(
    items: impl Fn() -> Vec<MenuNode>,
) -> impl Fn(&GuestKeyInput) -> bool {
    move |input| {
        let Some(spec) = spec_from_event(&input.key_like()) else {
            return false;
        };
        let mut chords = Vec::new();
        menu_chords(&items(), &mut chords);
        chords.contains(&spec)
    }
}
