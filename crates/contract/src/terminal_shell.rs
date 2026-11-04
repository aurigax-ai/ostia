use ostia_base::js::{js_trim, utf16_len};

use crate::argv::split_args;

pub const SHELL_SETTING_MAX_LENGTH: usize = 1024;

pub fn parse_shell_setting(raw: &str) -> &str {
    if utf16_len(raw) <= SHELL_SETTING_MAX_LENGTH {
        js_trim(raw)
    } else {
        ""
    }
}

pub fn shell_argv(setting: &str, fallback: &str) -> Vec<String> {
    match split_args(parse_shell_setting(setting)) {
        Some(tokens)
            if !tokens.is_empty()
                && tokens
                    .iter()
                    .all(|token| !token.is_empty() && !token.contains('\0')) =>
        {
            tokens
        }
        _ => vec![fallback.to_owned()],
    }
}

pub fn shell_name(program: &str) -> &str {
    program
        .rfind(['/', '\\'])
        .map_or(program, |index| &program[index + 1..])
}
