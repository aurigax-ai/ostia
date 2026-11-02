use std::collections::HashMap;
use std::sync::Arc;

use ostia_base::js::{js_trim, utf16_len};
use ostia_contract::hidden_text::has_control_character;
use parking_lot::Mutex;
use serde_json::Value;

use crate::hidden_text::is_hidden_format;

const NAME_MAX: usize = 40;
const DESC_MAX: usize = 200;
const SHORT_ID_LENGTH: usize = 8;
const NAME_RULE: &str = "name is 1-40 lowercase letters, digits, '-' or '.', starting and ending with a letter or digit";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneName {
    pub name: String,
    pub desc: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Claim {
    Held(PaneName),
    NameTaken { name: String, holder: String },
    BadName(String),
    BadDesc(String),
}

#[derive(Default)]
struct Books {
    held: HashMap<String, PaneName>,
    holders: HashMap<String, String>,
    sessions: HashMap<String, String>,
}

#[derive(Clone, Default)]
pub struct PaneNames {
    books: Arc<Mutex<Books>>,
}

impl PaneNames {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn claim_name(&self, pane_id: &str, raw_name: &Value, raw_desc: Option<&Value>) -> Claim {
        let name = match parse_name(raw_name) {
            Ok(name) => name,
            Err(message) => return Claim::BadName(message),
        };
        let desc = match parse_desc(raw_desc) {
            Ok(desc) => desc,
            Err(message) => return Claim::BadDesc(message),
        };
        let mut books = self.books.lock();
        if let Some(holder) = books
            .holders
            .get(&name)
            .filter(|holder| holder.as_str() != pane_id)
        {
            return Claim::NameTaken {
                name,
                holder: holder.clone(),
            };
        }
        release(&mut books, pane_id);
        let entry = PaneName {
            name: name.clone(),
            desc,
        };
        books.held.insert(pane_id.to_owned(), entry.clone());
        books.holders.insert(name, pane_id.to_owned());
        Claim::Held(entry)
    }

    pub fn name_of(&self, pane_id: &str) -> Option<PaneName> {
        self.books.lock().held.get(pane_id).cloned()
    }

    pub fn pane_named(&self, name: &str) -> Option<String> {
        self.books.lock().holders.get(name).cloned()
    }

    pub fn drop_name(&self, pane_id: &str) -> bool {
        let mut books = self.books.lock();
        books.sessions.remove(pane_id);
        release(&mut books, pane_id)
    }

    pub fn drop_names_where(&self, should_drop: impl Fn(&str) -> bool) {
        let panes: Vec<String> = self.books.lock().held.keys().cloned().collect();
        for pane_id in panes {
            if should_drop(&pane_id) {
                self.drop_name(&pane_id);
            }
        }
    }

    pub fn note_agent_session(&self, pane_id: &str, agent: &str, session_id: &str) {
        let session = format!("{agent}:{session_id}");
        let mut books = self.books.lock();
        if books
            .sessions
            .get(pane_id)
            .is_some_and(|before| *before != session)
        {
            release(&mut books, pane_id);
        }
        books.sessions.insert(pane_id.to_owned(), session);
    }

    pub fn forget_names(&self) {
        let mut books = self.books.lock();
        books.held.clear();
        books.holders.clear();
        books.sessions.clear();
    }
}

fn release(books: &mut Books, pane_id: &str) -> bool {
    let Some(entry) = books.held.remove(pane_id) else {
        return false;
    };
    books.holders.remove(&entry.name);
    true
}

fn is_edge(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

fn is_slug(text: &str) -> bool {
    match text.as_bytes() {
        [] => false,
        [only] => is_edge(*only),
        [first, .., last] => {
            is_edge(*first)
                && is_edge(*last)
                && text
                    .bytes()
                    .all(|byte| is_edge(byte) || byte == b'.' || byte == b'-')
        }
    }
}

pub fn parse_name(raw: &Value) -> Result<String, String> {
    let Some(name) = raw.as_str() else {
        return Err("name must be text".to_owned());
    };
    if name.len() > NAME_MAX || !is_slug(name) {
        return Err(NAME_RULE.to_owned());
    }
    if name.len() >= SHORT_ID_LENGTH
        && name
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("name looks like a pane id; add a letter that is not a hex digit".to_owned());
    }
    Ok(name.to_owned())
}

fn is_hidden_char(ch: char) -> bool {
    let mut units = [0_u16; 2];
    is_hidden_format(u32::from(ch.encode_utf16(&mut units)[0]))
}

pub fn parse_desc(raw: Option<&Value>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Some(text) = raw.as_str() else {
        return Err("description must be text".to_owned());
    };
    let desc = js_trim(text);
    if utf16_len(desc) > DESC_MAX {
        return Err(format!("description is at most {DESC_MAX} characters"));
    }
    if has_control_character(desc) || desc.chars().any(is_hidden_char) {
        return Err("description is one line without control or format characters".to_owned());
    }
    Ok((!desc.is_empty()).then(|| desc.to_owned()))
}
