use std::collections::HashMap;
use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde_json::{Map, Number, Value};

const MAX_NESTING: usize = 64;

static IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z_$][A-Za-z0-9_$]*$"));

#[derive(Debug, Clone, PartialEq)]
pub struct LocatedJson {
    pub value: Value,
    pub lines: HashMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonSyntaxError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

pub fn child_path(parent: &str, key: &str) -> String {
    if !IDENTIFIER.is_match(key) {
        let quoted = serde_json::to_string(key).unwrap_or_default();
        return format!("{parent}[{quoted}]");
    }
    if parent.is_empty() {
        key.to_owned()
    } else {
        format!("{parent}.{key}")
    }
}

pub fn child_index_path(parent: &str, index: usize) -> String {
    format!("{parent}[{index}]")
}

struct Failure {
    message: String,
    at: usize,
}

fn fail(message: impl Into<String>, at: usize) -> Failure {
    Failure {
        message: message.into(),
        at,
    }
}

const QUOTE: u16 = b'"' as u16;
const BACKSLASH: u16 = b'\\' as u16;
const OPEN_BRACE: u16 = b'{' as u16;
const CLOSE_BRACE: u16 = b'}' as u16;
const OPEN_BRACKET: u16 = b'[' as u16;
const CLOSE_BRACKET: u16 = b']' as u16;
const COMMA: u16 = b',' as u16;
const COLON: u16 = b':' as u16;
const NEWLINE: u16 = b'\n' as u16;

fn escape_unit(unit: u16) -> Option<u16> {
    let mapped = match u8::try_from(unit).ok()? {
        b'"' => b'"',
        b'\\' => b'\\',
        b'/' => b'/',
        b'b' => 0x08,
        b'f' => 0x0c,
        b'n' => b'\n',
        b'r' => b'\r',
        b't' => b'\t',
        _ => return None,
    };
    Some(u16::from(mapped))
}

fn parse_hex4(units: &[u16]) -> Option<u16> {
    if units.len() != 4 {
        return None;
    }
    units.iter().try_fold(0u16, |value, unit| {
        let digit = char::from_u32(u32::from(*unit))?.to_digit(16)?;
        Some((value << 4) | digit as u16)
    })
}

fn is_ascii_digit(unit: Option<u16>) -> bool {
    matches!(unit, Some(0x30..=0x39))
}

struct Parser {
    units: Vec<u16>,
    at: usize,
    cursor_at: usize,
    cursor_line: usize,
    lines: HashMap<String, usize>,
}

impl Parser {
    fn new(text: &str) -> Self {
        Self {
            units: text.encode_utf16().collect(),
            at: 0,
            cursor_at: 0,
            cursor_line: 1,
            lines: HashMap::new(),
        }
    }

    fn unit(&self, index: usize) -> Option<u16> {
        self.units.get(index).copied()
    }

    fn current_line(&mut self) -> usize {
        while self.cursor_at < self.at {
            if self.unit(self.cursor_at) == Some(NEWLINE) {
                self.cursor_line += 1;
            }
            self.cursor_at += 1;
        }
        self.cursor_line
    }

    fn skip(&mut self) {
        while matches!(self.unit(self.at), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.at += 1;
        }
    }

    fn expect(&mut self, expected: u16) -> Result<(), Failure> {
        if self.unit(self.at) != Some(expected) {
            let symbol = String::from_utf16_lossy(&[expected]);
            let message = if self.at >= self.units.len() {
                format!("expected '{symbol}' before the end")
            } else {
                format!("expected '{symbol}'")
            };
            return Err(fail(message, self.at));
        }
        self.at += 1;
        Ok(())
    }

    fn read_string(&mut self) -> Result<String, Failure> {
        self.expect(QUOTE)?;
        let mut out: Vec<u16> = Vec::new();
        loop {
            let Some(unit) = self.unit(self.at) else {
                return Err(fail("unterminated string", self.at));
            };
            if unit == QUOTE {
                self.at += 1;
                return Ok(String::from_utf16_lossy(&out));
            }
            if unit < 0x20 {
                return Err(fail("control character in string", self.at));
            }
            if unit != BACKSLASH {
                out.push(unit);
                self.at += 1;
                continue;
            }
            if self.unit(self.at + 1) == Some(u16::from(b'u')) {
                let code = self
                    .units
                    .get(self.at + 2..self.at + 6)
                    .and_then(parse_hex4)
                    .ok_or_else(|| fail("bad \\u escape", self.at))?;
                out.push(code);
                self.at += 6;
                continue;
            }
            let mapped = self
                .unit(self.at + 1)
                .and_then(escape_unit)
                .ok_or_else(|| fail("bad escape", self.at))?;
            out.push(mapped);
            self.at += 2;
        }
    }

    fn number_end(&self) -> Option<usize> {
        let mut end = self.at;
        if self.unit(end) == Some(u16::from(b'-')) {
            end += 1;
        }
        match self.unit(end) {
            Some(0x30) => end += 1,
            Some(0x31..=0x39) => {
                end += 1;
                while is_ascii_digit(self.unit(end)) {
                    end += 1;
                }
            }
            _ => return None,
        }
        if self.unit(end) == Some(u16::from(b'.')) && is_ascii_digit(self.unit(end + 1)) {
            end += 2;
            while is_ascii_digit(self.unit(end)) {
                end += 1;
            }
        }
        if matches!(self.unit(end), Some(0x45 | 0x65)) {
            let mut exponent = end + 1;
            if matches!(self.unit(exponent), Some(0x2b | 0x2d)) {
                exponent += 1;
            }
            if is_ascii_digit(self.unit(exponent)) {
                while is_ascii_digit(self.unit(exponent)) {
                    exponent += 1;
                }
                end = exponent;
            }
        }
        Some(end)
    }

    fn starts_with(&self, word: &str) -> bool {
        word.encode_utf16()
            .enumerate()
            .all(|(offset, unit)| self.unit(self.at + offset) == Some(unit))
    }

    fn read_number_or_literal(&mut self) -> Result<Value, Failure> {
        for (word, value) in [
            ("true", Value::Bool(true)),
            ("false", Value::Bool(false)),
            ("null", Value::Null),
        ] {
            if self.starts_with(word) {
                self.at += word.len();
                return Ok(value);
            }
        }
        if let Some(end) = self.number_end() {
            let text = String::from_utf16_lossy(&self.units[self.at..end]);
            let number = text
                .parse::<f64>()
                .ok()
                .and_then(json_number)
                .ok_or_else(|| fail("number out of range", self.at))?;
            self.at = end;
            return Ok(Value::Number(number));
        }
        let message = match self.unit(self.at) {
            None => "unexpected end of file".to_owned(),
            Some(unit) => format!("unexpected '{}'", String::from_utf16_lossy(&[unit])),
        };
        Err(fail(message, self.at))
    }

    fn read_object(&mut self, path: &str, depth: usize) -> Result<Value, Failure> {
        self.at += 1;
        let mut out = Map::new();
        self.skip();
        if self.unit(self.at) == Some(CLOSE_BRACE) {
            self.at += 1;
            return Ok(Value::Object(out));
        }
        loop {
            self.skip();
            let key_at = self.at;
            if self.unit(self.at) != Some(QUOTE) {
                return Err(fail("expected a quoted property name", self.at));
            }
            let key = self.read_string()?;
            if out.contains_key(&key) {
                return Err(fail(format!("duplicate property '{key}'"), key_at));
            }
            self.skip();
            self.expect(COLON)?;
            let value = self.read_value(&child_path(path, &key), depth + 1)?;
            out.insert(key, value);
            self.skip();
            if self.unit(self.at) == Some(COMMA) {
                self.at += 1;
                continue;
            }
            self.expect(CLOSE_BRACE)?;
            return Ok(Value::Object(out));
        }
    }

    fn read_array(&mut self, path: &str, depth: usize) -> Result<Value, Failure> {
        self.at += 1;
        let mut out = Vec::new();
        self.skip();
        if self.unit(self.at) == Some(CLOSE_BRACKET) {
            self.at += 1;
            return Ok(Value::Array(out));
        }
        loop {
            let item = self.read_value(&child_index_path(path, out.len()), depth + 1)?;
            out.push(item);
            self.skip();
            if self.unit(self.at) == Some(COMMA) {
                self.at += 1;
                continue;
            }
            self.expect(CLOSE_BRACKET)?;
            return Ok(Value::Array(out));
        }
    }

    fn read_value(&mut self, path: &str, depth: usize) -> Result<Value, Failure> {
        if depth > MAX_NESTING {
            return Err(fail("nested too deeply", self.at));
        }
        self.skip();
        let line = self.current_line();
        self.lines.insert(path.to_owned(), line);
        match self.unit(self.at) {
            Some(OPEN_BRACE) => self.read_object(path, depth),
            Some(OPEN_BRACKET) => self.read_array(path, depth),
            Some(QUOTE) => self.read_string().map(Value::String),
            _ => self.read_number_or_literal(),
        }
    }

    fn syntax_error(&self, failure: Failure) -> JsonSyntaxError {
        let at = failure.at.min(self.units.len());
        let before = &self.units[..at];
        let line = 1 + before.iter().filter(|unit| **unit == NEWLINE).count();
        let line_start = before
            .iter()
            .rposition(|unit| *unit == NEWLINE)
            .map_or(0, |newline| newline + 1);
        JsonSyntaxError {
            message: failure.message,
            line,
            column: failure.at - line_start + 1,
        }
    }
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn json_number(value: f64) -> Option<Number> {
    if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
        Some(Number::from(value as i64))
    } else {
        Number::from_f64(value)
    }
}

pub fn parse_located_json(text: &str) -> Result<LocatedJson, JsonSyntaxError> {
    let mut parser = Parser::new(text);
    let value = match parser.read_value("", 0) {
        Ok(value) => value,
        Err(failure) => return Err(parser.syntax_error(failure)),
    };
    parser.skip();
    if parser.at < parser.units.len() {
        return Err(parser.syntax_error(fail("unexpected text after the document", parser.at)));
    }
    Ok(LocatedJson {
        value,
        lines: parser.lines,
    })
}
