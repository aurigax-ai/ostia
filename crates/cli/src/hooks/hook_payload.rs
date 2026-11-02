use ostia_base::js::js_trim;
use serde_json::Value;

const MESSAGE_MAX: usize = 300;

pub fn parse_payload(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

pub fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map_or_else(String::new, |text| take_utf16(js_trim(text), MESSAGE_MAX))
}

pub fn first_question(input: Option<&Value>) -> String {
    input
        .and_then(|input| input.get("questions"))
        .and_then(Value::as_array)
        .and_then(|questions| questions.first())
        .map_or_else(String::new, |first| text(first.get("question")))
}

fn take_utf16(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        end += ch.len_utf8();
    }
    text[..end].to_owned()
}
