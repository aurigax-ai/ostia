use ostia_base::js::js_trim;

use crate::agent_stop::parse_agent_stop;
use crate::question_text::{clip_to, one_line, plain_block};

pub const STATUS_MESSAGE_MAX: usize = 280;

pub fn closing_line(text: &str) -> Option<String> {
    let block = plain_block(text);
    let first = block.split('\n').find(|line| !js_trim(line).is_empty())?;
    let line = one_line(first);
    (!line.is_empty()).then(|| clip_to(&line, STATUS_MESSAGE_MAX))
}

pub fn closing_from_stop(raw: &str) -> Option<String> {
    let stop = parse_agent_stop("claude", raw)?;
    closing_line(&stop.message?)
}
