const LOOPBACK_NAMES: [&str; 2] = ["", "localhost"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CwdReport {
    pub host: String,
    pub path: String,
}

fn is_js_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub fn parse_osc7(data: &str) -> Option<CwdReport> {
    let rest = data.strip_prefix("file://")?;
    let slash = rest.find('/')?;
    let (host, path) = rest.split_at(slash);
    if path.chars().any(is_js_line_terminator) {
        return None;
    }
    Some(CwdReport {
        host: host.to_owned(),
        path: path.to_owned(),
    })
}

pub fn is_host_named(host: &str, local: Option<&str>) -> bool {
    let name = host.to_lowercase();
    let Some(local) = local else {
        return true;
    };
    if LOOPBACK_NAMES.contains(&name.as_str()) {
        return true;
    }
    let full = local.to_lowercase();
    name == full || full.split('.').next() == Some(name.as_str())
}
