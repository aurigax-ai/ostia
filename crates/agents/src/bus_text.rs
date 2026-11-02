use ostia_base::js::js_trim;
use ostia_contract::question_text::{clip_to, one_line, plain_block};

const BUS_PREVIEW_MAX: usize = 120;

pub fn bus_preview(text: &str) -> String {
    let block = plain_block(text);
    let first_line = block
        .split('\n')
        .find(|line| !js_trim(line).is_empty())
        .unwrap_or("");
    clip_to(&one_line(first_line), BUS_PREVIEW_MAX)
}
