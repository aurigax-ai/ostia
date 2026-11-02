use ostia_base::js::js_number_text;
use ostia_contract::hidden_text::{code_escape, is_control, is_hidden_format};
use serde_json::Value;

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_text(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn escape_char(ch: char) -> String {
    let code = u32::from(ch);
    if !is_control(code) && !is_hidden_format(code) {
        return ch.to_string();
    }
    match ch {
        '\t' => "\\t".to_owned(),
        '\n' => "\\n".to_owned(),
        '\r' => "\\r".to_owned(),
        _ => code_escape(code),
    }
}

pub fn line_field(value: &Value) -> String {
    js_string(value).chars().map(escape_char).collect()
}

pub fn tsv_line(fields: &[Value]) -> String {
    fields.iter().map(line_field).collect::<Vec<_>>().join("\t")
}
