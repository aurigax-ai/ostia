use std::io;

use crate::host::Platform;

const LEGACY_TIOCSTI: &str = "/proc/sys/dev/tty/legacy_tiocsti";

pub fn read_proc(path: &str) -> io::Result<String> {
    std::fs::read_to_string(path)
}

pub fn terminal_injection_off(read: impl Fn(&str) -> io::Result<String>) -> bool {
    read(LEGACY_TIOCSTI).is_ok_and(|text| crate::js::js_trim(&text) == "0")
}

pub fn needs_pty_relay(
    forced: bool,
    read: impl Fn(&str) -> io::Result<String>,
    platform: Platform,
) -> bool {
    platform == Platform::Linux && (forced || !terminal_injection_off(read))
}
