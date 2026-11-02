pub const GATEKEEPER_WINDOW_MS: u64 = 5000;

pub const SIGKILL_EXIT_CODE: i32 = 137;

pub const DEVELOPER_TOOLS_SETTING_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_DevTools";

pub struct ExitFacts<'a> {
    pub platform: &'a str,
    pub exit_code: Option<i32>,
    pub ran_ms: Option<f64>,
}

pub fn maybe_ended_by_gatekeeper(facts: &ExitFacts<'_>) -> bool {
    facts.platform == "darwin"
        && facts.exit_code == Some(SIGKILL_EXIT_CODE)
        && facts
            .ran_ms
            .is_some_and(|ms| (0.0..GATEKEEPER_WINDOW_MS as f64).contains(&ms))
}

pub fn gatekeeper_hint(product: &str) -> String {
    let seconds = GATEKEEPER_WINDOW_MS / 1000;
    format!(
        "macOS Gatekeeper may have ended this process: it was killed (exit {SIGKILL_EXIT_CODE}) within {seconds} seconds of starting. If the program was just installed or upgraded, open System Settings > Privacy & Security > Developer Tools, add or turn on {product} (use the + button if it is not listed), then run it again. Setting: {DEVELOPER_TOOLS_SETTING_URL}"
    )
}
