use std::io;

use crate::host::Platform;
use crate::js::is_js_space;

const STATUS_PATH: &str = "/proc/self/status";
const FLAG_PREFIX: &str = "NoNewPrivs:";

fn is_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn flag_line_is_set(rest: &str) -> bool {
    let Some(rest) = rest.strip_prefix(FLAG_PREFIX) else {
        return false;
    };
    let Some(rest) = rest.trim_start_matches(is_js_space).strip_prefix('1') else {
        return false;
    };
    let mut trailing = rest.chars();
    loop {
        match trailing.next() {
            None => return true,
            Some(ch) if is_line_terminator(ch) => return true,
            Some(ch) if is_js_space(ch) => {}
            Some(_) => return false,
        }
    }
}

pub fn parse_no_new_privs(status: &str) -> bool {
    let line_starts = std::iter::once(0).chain(
        status
            .char_indices()
            .filter(|(_, ch)| is_line_terminator(*ch))
            .map(|(index, ch)| index + ch.len_utf8()),
    );
    line_starts
        .filter_map(|start| status.get(start..))
        .any(flag_line_is_set)
}

pub fn read_no_new_privs(
    platform: Platform,
    read: impl FnOnce(&str) -> io::Result<String>,
) -> bool {
    if platform != Platform::Linux {
        return false;
    }
    read(STATUS_PATH).is_ok_and(|status| parse_no_new_privs(&status))
}
