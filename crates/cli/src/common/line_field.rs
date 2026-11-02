use ostia_contract::hidden_text::{code_escape, is_control, is_hidden_format};
use serde_json::Value;

fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        let text = if value > 0.0 { "Infinity" } else { "-Infinity" };
        return text.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", value.abs());
    let Some((mantissa, exponent)) = scientific.split_once('e') else {
        return scientific;
    };
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|ch| *ch != '.').collect();
    let count = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let point = exponent + 1;
    let body = if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(point as usize);
        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let exp = point - 1;
        let sign_exp = if exp < 0 { '-' } else { '+' };
        let coefficient = match digits.split_at(1) {
            (lead, rest) if !rest.is_empty() => format!("{lead}.{rest}"),
            _ => digits.clone(),
        };
        format!("{coefficient}e{sign_exp}{}", exp.abs())
    };
    format!("{sign}{body}")
}

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
