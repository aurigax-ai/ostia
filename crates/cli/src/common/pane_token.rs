use ostia_base::host::Host;
use ostia_base::js::js_trim;

pub fn pane_token(host: &Host) -> Option<String> {
    if let Some(token) = host.app_var("TOKEN") {
        return Some(token.to_owned());
    }
    let text = std::fs::read_to_string(host.app_var("TOKEN_FILE")?).ok()?;
    let token = js_trim(&text);
    (!token.is_empty()).then(|| token.to_owned())
}
