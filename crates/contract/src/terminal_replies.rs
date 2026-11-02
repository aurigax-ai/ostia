use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;

const ESC: &str = r"\x1b";
const ST: &str = r"(?:\x07|\x1b\\)";
const CURSOR_POSITION: &str = r"\[(?:(?:[02-9][0-9]*|1[0-9]+);[0-9]+|1;(?:[019]|[0-9]{2,}))R";

static TERMINAL_REPLIES: LazyLock<Regex> = LazyLock::new(|| {
    let replies = [
        format!(r"{ESC}\[[IO]"),
        format!(r"{ESC}\[[?>=]?[0-9;]*c"),
        format!(r"{ESC}\[\??[0-9;]*n"),
        format!(r"{ESC}\[\?[0-9]+;[0-9]+(?:;[0-9]+)?R"),
        format!("{ESC}{CURSOR_POSITION}"),
        format!(r"{ESC}\[\??[0-9]+;[0-9]+\$y"),
        format!(r"{ESC}\[[0-9]+(?:;[0-9]+)+t"),
        format!(r"{ESC}\[\?[0-9]+u"),
        format!(r"{ESC}\][0-9;]+;[^\x07\x1b]*{ST}"),
        format!(r"{ESC}\][lL][^\x07\x1b]*{ST}"),
        format!(r"{ESC}P[^\x1b]*{ESC}\\"),
    ];
    static_regex(&format!("^(?:{})+$", replies.join("|")))
});

pub fn is_terminal_reply(data: &str) -> bool {
    TERMINAL_REPLIES.is_match(data)
}
