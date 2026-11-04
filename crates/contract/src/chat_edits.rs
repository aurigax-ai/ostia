use serde::Serialize;
use serde_json::Value;

pub const CHAT_EDITS_MAX: usize = 32;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEdit {
    pub old_text: String,
    pub new_text: String,
    #[serde(skip_serializing_if = "is_false")]
    pub replace_all: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatEditError {
    NoMatch,
    Ambiguous,
    NoChange,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatEditFailure {
    pub error: ChatEditError,
    pub edit: usize,
    pub count: Option<usize>,
}

fn first_present<'a>(raw: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    match raw.get(snake) {
        Some(value) if !value.is_null() => Some(value),
        _ => raw.get(camel).filter(|value| !value.is_null()),
    }
}

fn edit_of(raw: &Value) -> Option<ChatEdit> {
    if !raw.is_object() {
        return None;
    }
    let old_text = first_present(raw, "old_text", "oldText")?.as_str()?;
    let new_text = first_present(raw, "new_text", "newText")?.as_str()?;
    if old_text.is_empty() {
        return None;
    }
    let replace_all = first_present(raw, "replace_all", "replaceAll") == Some(&Value::Bool(true));
    Some(ChatEdit {
        old_text: old_text.to_owned(),
        new_text: new_text.to_owned(),
        replace_all,
    })
}

pub fn parse_edits(input: &Value) -> Option<Vec<ChatEdit>> {
    if !input.is_object() {
        return None;
    }
    let single = std::slice::from_ref(input);
    let list = match input.get("edits") {
        Some(Value::Array(items)) => items.as_slice(),
        _ => single,
    };
    if list.is_empty() || list.len() > CHAT_EDITS_MAX {
        return None;
    }
    list.iter().map(edit_of).collect()
}

fn count(text: &str, needle: &str) -> usize {
    let Some(first) = needle.chars().next() else {
        return 0;
    };
    let step = first.len_utf8();
    let mut found = 0;
    let mut from = 0;
    while let Some(offset) = text[from..].find(needle) {
        found += 1;
        from += offset + step;
    }
    found
}

fn crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn with_file_line_endings(text: &str, edit: &ChatEdit) -> ChatEdit {
    if !text.contains("\r\n") {
        return edit.clone();
    }
    let old_text = if edit.old_text.contains('\r') || text.contains(&edit.old_text) {
        edit.old_text.clone()
    } else {
        crlf(&edit.old_text)
    };
    let new_text = if edit.new_text.contains('\r') {
        edit.new_text.clone()
    } else {
        crlf(&edit.new_text)
    };
    ChatEdit {
        old_text,
        new_text,
        replace_all: edit.replace_all,
    }
}

fn failure(error: ChatEditError, edit: usize, count: Option<usize>) -> ChatEditFailure {
    ChatEditFailure { error, edit, count }
}

pub fn apply_edits(text: &str, edits: &[ChatEdit]) -> Result<String, ChatEditFailure> {
    let mut current = text.to_owned();
    for (index, raw) in edits.iter().enumerate() {
        let edit = with_file_line_endings(&current, raw);
        let found = count(&current, &edit.old_text);
        if found == 0 {
            return Err(failure(ChatEditError::NoMatch, index, None));
        }
        if found > 1 && !edit.replace_all {
            return Err(failure(ChatEditError::Ambiguous, index, Some(found)));
        }
        current = if edit.replace_all {
            current.replace(&edit.old_text, &edit.new_text)
        } else {
            current.replacen(&edit.old_text, &edit.new_text, 1)
        };
    }
    if current == text {
        Err(failure(ChatEditError::NoChange, 0, None))
    } else {
        Ok(current)
    }
}
