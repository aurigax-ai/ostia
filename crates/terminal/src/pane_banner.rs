const ERROR_SGR: &str = "\x1b[38;2;239;89;111m";

pub fn error_banner(text: &str) -> String {
    format!("\r\n{ERROR_SGR} {text}\x1b[0m\r\n")
}

pub fn integration_not_loaded_notice(template: &str, reason: &str) -> String {
    error_banner(&template.replace("{reason}", reason))
}
