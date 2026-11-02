use base64::Engine as _;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use ostia_base::js_json::parse_js_json;
use serde_json::Value;

const SEND_KEYS_CHUNK: usize = 512;
const WITHOUT_TMUX_ENV: [&str; 5] = ["/usr/bin/env", "-u", "TMUX", "-u", "TMUX_PANE"];
const TOLERANT_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub const META_OPTION: &str = "@ostia-meta";

pub struct NewWindowSpec {
    pub session: String,
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

pub fn tmux_quote(arg: &str) -> String {
    let mut out = String::from("\"");
    for ch in arg.chars() {
        let code = u32::from(ch);
        match ch {
            '\\' | '"' | '$' => {
                out.push('\\');
                out.push(ch);
            }
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ if code < 0x20 || code == 0x7f => out.push_str(&format!("\\{code:03o}")),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn tmux_format_quote(arg: &str) -> String {
    tmux_quote(&arg.replace('#', "##"))
}

pub fn send_keys_commands(target: &str, data: &str) -> Vec<String> {
    data.as_bytes()
        .chunks(SEND_KEYS_CHUNK)
        .map(|chunk| {
            let hex = chunk
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(" ");
            format!("send-keys -t {target} -H {hex}")
        })
        .collect()
}

pub fn new_window_command(spec: &NewWindowSpec) -> String {
    let env = spec
        .env
        .iter()
        .filter(|(key, _)| !key.is_empty() && !key.contains('='))
        .map(|(key, value)| format!("-e {}", tmux_quote(&format!("{key}={value}"))));
    let argv = WITHOUT_TMUX_ENV
        .into_iter()
        .chain(std::iter::once(spec.file.as_str()))
        .chain(spec.args.iter().map(String::as_str))
        .map(tmux_quote);
    let mut parts = vec![
        "new-window -d -P -F \"#{window_id} #{pane_id} #{pane_pid}\"".to_owned(),
        format!("-t {}", tmux_quote(&format!("{}:", spec.session))),
        format!("-c {}", tmux_format_quote(&spec.cwd)),
    ];
    parts.extend(env);
    parts.push("--".to_owned());
    parts.extend(argv);
    parts.join(" ")
}

pub fn encode_meta(meta: &Value) -> String {
    STANDARD.encode(meta.to_string())
}

fn base64_symbol(ch: char) -> Option<char> {
    match ch {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(ch),
        '-' => Some('+'),
        '_' => Some('/'),
        _ => None,
    }
}

pub fn decode_meta(raw: &str) -> Value {
    if raw.is_empty() {
        return Value::Null;
    }
    let symbols: String = raw
        .chars()
        .take_while(|ch| *ch != '=')
        .filter_map(base64_symbol)
        .collect();
    let usable = if symbols.len() % 4 == 1 {
        &symbols[..symbols.len() - 1]
    } else {
        symbols.as_str()
    };
    TOLERANT_BASE64
        .decode(usable)
        .ok()
        .and_then(|bytes| parse_js_json(&String::from_utf8_lossy(&bytes)).ok())
        .unwrap_or(Value::Null)
}
