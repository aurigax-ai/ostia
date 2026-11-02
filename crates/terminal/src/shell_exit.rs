pub const STARTUP_FAILURE_MS: u64 = 3_000;

#[derive(Clone, Copy, Debug)]
pub struct ShellExit {
    pub own_exit: bool,
    pub code: i32,
    pub lived_ms: u64,
}

pub fn closes_pane_on_exit(exit: ShellExit) -> bool {
    if !exit.own_exit {
        return false;
    }
    exit.code == 0 || exit.lived_ms >= STARTUP_FAILURE_MS
}
