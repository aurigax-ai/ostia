use std::sync::LazyLock;

use ostia_base::js::static_regex;
use ostia_base::{PRODUCT_NAME, Platform};
use ostia_contract::dict::fmt;
use ostia_contract::pane_banner_text::{PaneBannerText, error_banner};
use regex::Regex;
use serde_json::json;

static PACKAGE_BY_ERROR: LazyLock<[(Regex, &'static str); 3]> = LazyLock::new(|| {
    [
        (static_regex(r"(?i-u)bubblewrap|bwrap"), "bubblewrap"),
        (static_regex(r"(?i-u)socat"), "socat"),
        (static_regex(r"(?i-u)ripgrep|\brg\b"), "ripgrep"),
    ]
});

pub fn missing_packages(errors: &[&str]) -> Vec<&'static str> {
    let mut found: Vec<&'static str> = Vec::new();
    for error in errors {
        for (pattern, package) in PACKAGE_BY_ERROR.iter() {
            if pattern.is_match(error) && !found.contains(package) {
                found.push(*package);
            }
        }
    }
    found
}

pub fn sandbox_failure_banner(t: &PaneBannerText, message: &str, missing: &[&str]) -> String {
    let mut lines = vec![error_banner(&fmt(
        &t.sandbox_unavailable,
        &json!({"message": message}),
    ))];
    let packages = missing_packages(missing);
    if !packages.is_empty() {
        let joined = packages.join(", ");
        lines.push(format!(
            " {}\r\n",
            fmt(&t.missing, &json!({"packages": joined}))
        ));
        let command = format!("{PRODUCT_NAME} system install {}", packages.join(" "));
        lines.push(format!(
            " {}\r\n",
            fmt(&t.install, &json!({"command": command}))
        ));
    }
    lines.push(format!(" {}\r\n", t.no_shell));
    lines.concat()
}

pub fn hidden_home_notice(t: &PaneBannerText, platform: Platform) -> String {
    if platform != Platform::Linux {
        return String::new();
    }
    let lines: Vec<String> = t
        .hidden_home
        .split('\n')
        .map(|line| format!(" {line}"))
        .collect();
    format!("\x1b[2m{}\x1b[0m\r\n", lines.join("\r\n"))
}
