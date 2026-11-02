use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;

const VALUE_FLAGS: &str = "BbcDEeFIiJLlmOoPpQRSWw";
const NO_SESSION_FLAGS: &str = "GVQO";

static HOST: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$|^\[?[0-9A-Fa-f:.%]{2,64}\]?$")
});
static USER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$"));
static URL_PATH: LazyLock<Regex> = LazyLock::new(|| static_regex(r"/[^\n\r\x{2028}\x{2029}]*$"));
static URL_PORT: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^([^\n\r\x{2028}\x{2029}]*@)?(\[[^\]]*\]|[^:]*):[0-9]+$"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshLogin {
    pub user: Option<String>,
    pub host: String,
}

fn login_of(destination: &str, flag_user: Option<&str>) -> Option<SshLogin> {
    let mut rest = destination.to_owned();
    if let Some(after) = destination.strip_prefix("ssh://") {
        rest = URL_PATH.replace(after, "").into_owned();
        rest = URL_PORT.replace(&rest, "${1}${2}").into_owned();
    }
    let mut user = None;
    if let Some(at) = rest.rfind('@') {
        user = Some(rest[..at].to_owned());
        rest = rest[at + 1..].to_owned();
    }
    if !HOST.is_match(&rest) {
        return None;
    }
    let who = user
        .filter(|text| !text.is_empty())
        .or_else(|| flag_user.map(str::to_owned));
    match who {
        Some(who) if USER.is_match(&who) => Some(SshLogin {
            user: Some(who),
            host: rest,
        }),
        _ => Some(SshLogin {
            user: None,
            host: rest,
        }),
    }
}

pub fn ssh_args<'a>(argv: &[&'a str]) -> Vec<&'a str> {
    let start = argv
        .iter()
        .position(|arg| arg.rsplit('/').next() == Some("ssh"))
        .map_or(0, |index| index + 1);
    argv[start..]
        .iter()
        .copied()
        .filter(|arg| !arg.is_empty())
        .collect()
}

pub fn ssh_login(args: &[&str]) -> Option<SshLogin> {
    let mut flag_user: Option<&str> = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index];
        if arg == "--" {
            return args
                .get(index + 1)
                .and_then(|destination| login_of(destination, flag_user));
        }
        if !arg.starts_with('-') || arg == "-" {
            return login_of(arg, flag_user);
        }
        for (position, flag) in arg.char_indices().skip(1) {
            if NO_SESSION_FLAGS.contains(flag) {
                return None;
            }
            if VALUE_FLAGS.contains(flag) {
                let attached = &arg[position + flag.len_utf8()..];
                let value = if attached.is_empty() {
                    index += 1;
                    args.get(index).copied()
                } else {
                    Some(attached)
                };
                if flag == 'l' {
                    flag_user = value.or(flag_user);
                }
                break;
            }
        }
        index += 1;
    }
    None
}

pub fn ssh_label(login: &SshLogin) -> String {
    match login.user.as_deref().filter(|user| !user.is_empty()) {
        Some(user) => format!("{user}@{}", login.host),
        None => login.host.clone(),
    }
}
