use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SshLogin {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub host: String,
}

static HOST_RE: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$|^\[?[0-9A-Fa-f:.%]{2,64}\]?$")
});

static USER_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$"));

static SSH_PORT_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^(.*@)?(\[[^\]]*\]|[^:]*):\d+$"));

fn is_no_session_flag(ch: char) -> bool {
    matches!(ch, 'G' | 'V' | 'Q' | 'O')
}

fn is_value_flag(ch: char) -> bool {
    matches!(
        ch,
        'B' | 'b'
            | 'c'
            | 'D'
            | 'E'
            | 'e'
            | 'F'
            | 'I'
            | 'i'
            | 'J'
            | 'L'
            | 'l'
            | 'm'
            | 'O'
            | 'o'
            | 'P'
            | 'p'
            | 'Q'
            | 'R'
            | 'S'
            | 'W'
            | 'w'
    )
}

fn login_of(destination: &str, flag_user: Option<&str>) -> Option<SshLogin> {
    let mut rest = destination.to_owned();
    let mut user: Option<String> = None;
    if let Some(after) = rest.strip_prefix("ssh://") {
        rest = after.to_owned();
        if let Some(slash_idx) = rest.find('/') {
            rest.truncate(slash_idx);
        }
        if let Some(caps) = SSH_PORT_RE.captures(&rest) {
            let g1 = caps.get(1).map_or("", |m| m.as_str());
            let g2 = caps.get(2).map_or("", |m| m.as_str());
            rest = format!("{g1}{g2}");
        }
    }
    if let Some(at) = rest.rfind('@') {
        user = Some(rest[..at].to_owned());
        rest = rest[at + 1..].to_owned();
    }
    if !HOST_RE.is_match(&rest) {
        return None;
    }
    let who = match user {
        Some(u) if !u.is_empty() => Some(u),
        _ => flag_user.map(str::to_owned),
    };
    if let Some(ref w) = who {
        if USER_RE.is_match(w) {
            return Some(SshLogin {
                user: who,
                host: rest,
            });
        }
    }
    Some(SshLogin {
        user: None,
        host: rest,
    })
}

pub fn ssh_args(argv: &[&str]) -> Vec<String> {
    let at = argv.iter().position(|a| {
        let name = match a.rfind('/') {
            Some(idx) => &a[idx + 1..],
            None => *a,
        };
        name == "ssh"
    });
    let start = match at {
        Some(idx) => idx + 1,
        None => 0,
    };
    argv[start..]
        .iter()
        .filter(|a| !a.is_empty())
        .map(|a| (*a).to_owned())
        .collect()
}

pub fn ssh_login(args: &[&str]) -> Option<SshLogin> {
    let mut flag_user: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i];
        if arg == "--" {
            return if i + 1 < args.len() {
                login_of(args[i + 1], flag_user.as_deref())
            } else {
                None
            };
        }
        if !arg.starts_with('-') || arg == "-" {
            return login_of(arg, flag_user.as_deref());
        }
        for (j, ch) in arg.char_indices().skip(1) {
            if is_no_session_flag(ch) {
                return None;
            }
            if is_value_flag(ch) {
                let attached = &arg[j + ch.len_utf8()..];
                let value = if !attached.is_empty() {
                    Some(attached)
                } else {
                    i += 1;
                    args.get(i).copied()
                };
                if ch == 'l' {
                    if let Some(val) = value {
                        flag_user = Some(val.to_owned());
                    }
                }
                break;
            }
        }
        i += 1;
    }
    None
}

pub fn ssh_label(login: &SshLogin) -> String {
    match &login.user {
        Some(user) => format!("{user}@{}", login.host),
        None => login.host.clone(),
    }
}
