use std::collections::BTreeSet;

use ostia_base::js::utf16_len;
use serde::Serialize;
use serde_json::Value;

use crate::question_text::{clip_to, one_line, plain_block};

pub const QUESTION_MAX: usize = 500;
pub const QUESTION_CONTEXT_MAX: usize = 4000;
pub const QUESTION_CHOICES_MAX: usize = 12;
pub const QUESTION_CHOICE_MAX: usize = 120;
pub const QUESTION_REPLY_MAX: usize = 4000;
pub const QUESTIONS_PER_PANE: usize = 3;
pub const QUESTION_RATE_LIMIT: usize = 6;
pub const QUESTION_RATE_WINDOW_MS: u64 = 60_000;
const QUESTION_TIMEOUT_MIN_S: u64 = 1;
pub const QUESTION_TIMEOUT_MAX_S: u64 = 86_400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionMode {
    Text,
    Single,
    Multi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuestionAskError {
    InvalidQuestion,
    InvalidContext,
    InvalidChoices,
    InvalidTimeout,
    TooManyQuestions,
    RateLimited,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionRefusal {
    pub error: QuestionAskError,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionContent {
    pub question: String,
    pub context: String,
    pub choices: Vec<String>,
    pub mode: QuestionMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuestionReply {
    pub choices: Vec<usize>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionReplyTarget {
    pub choices: Vec<String>,
    pub mode: QuestionMode,
    pub permission: bool,
}

fn refuse(error: QuestionAskError, message: impl Into<String>) -> QuestionRefusal {
    QuestionRefusal {
        error,
        message: message.into(),
    }
}

fn read_choices(params: Option<&Value>) -> Result<Vec<String>, QuestionRefusal> {
    let invalid = |message: String| refuse(QuestionAskError::InvalidChoices, message);
    let raw: &[Value] = match params {
        None | Some(Value::Null) => &[],
        Some(Value::Array(list)) => list,
        Some(_) => return Err(invalid("choices must be a list of labels".to_owned())),
    };
    let mut labels = Vec::with_capacity(raw.len());
    for item in raw {
        match item.as_str() {
            Some(label) => labels.push(label),
            None => return Err(invalid("choices must be a list of labels".to_owned())),
        }
    }
    if labels.len() > QUESTION_CHOICES_MAX {
        return Err(invalid(format!("at most {QUESTION_CHOICES_MAX} choices")));
    }
    let choices: Vec<String> = labels.into_iter().map(one_line).collect();
    if choices.iter().any(String::is_empty) {
        return Err(invalid("a choice is empty".to_owned()));
    }
    if choices
        .iter()
        .any(|choice| utf16_len(choice) > QUESTION_CHOICE_MAX)
    {
        return Err(invalid(format!(
            "a choice is longer than {QUESTION_CHOICE_MAX} characters"
        )));
    }
    let distinct: BTreeSet<&String> = choices.iter().collect();
    if distinct.len() != choices.len() {
        return Err(invalid("two choices have the same label".to_owned()));
    }
    Ok(choices)
}

fn read_timeout(seconds: &Value) -> Result<u64, QuestionRefusal> {
    let in_range = seconds.as_f64().filter(|value| {
        value.is_finite()
            && *value >= QUESTION_TIMEOUT_MIN_S as f64
            && *value <= QUESTION_TIMEOUT_MAX_S as f64
    });
    match in_range {
        Some(value) => Ok((value * 1000.0).round() as u64),
        None => Err(refuse(
            QuestionAskError::InvalidTimeout,
            format!("timeout is {QUESTION_TIMEOUT_MIN_S} to {QUESTION_TIMEOUT_MAX_S} seconds"),
        )),
    }
}

pub fn normalize_question(raw: &Value) -> Result<QuestionContent, QuestionRefusal> {
    let needed = || refuse(QuestionAskError::InvalidQuestion, "a question is needed");
    let question = raw
        .get("question")
        .and_then(Value::as_str)
        .ok_or_else(needed)?;
    let question = one_line(question);
    if question.is_empty() {
        return Err(needed());
    }
    let context = match raw.get("context") {
        None => String::new(),
        Some(Value::String(text)) => plain_block(text),
        Some(_) => {
            return Err(refuse(
                QuestionAskError::InvalidContext,
                "context must be text",
            ));
        }
    };
    let choices = read_choices(raw.get("choices"))?;
    let multi = match raw.get("multi") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => {
            return Err(refuse(
                QuestionAskError::InvalidChoices,
                "multi must be true or false",
            ));
        }
    };
    if multi && choices.is_empty() {
        return Err(refuse(
            QuestionAskError::InvalidChoices,
            "multi needs at least one choice",
        ));
    }
    let timeout_ms = raw.get("timeoutSeconds").map(read_timeout).transpose()?;
    let mode = if choices.is_empty() {
        QuestionMode::Text
    } else if multi {
        QuestionMode::Multi
    } else {
        QuestionMode::Single
    };
    Ok(QuestionContent {
        question: clip_to(&question, QUESTION_MAX),
        context: clip_to(&context, QUESTION_CONTEXT_MAX),
        choices,
        mode,
        timeout_ms,
    })
}

fn choice_index(value: &Value, count: usize) -> Option<usize> {
    let number = value.as_f64()?;
    if number.fract() != 0.0 || number < 0.0 || number >= count as f64 {
        return None;
    }
    Some(number as usize)
}

pub fn normalize_reply(target: &QuestionReplyTarget, raw: &Value) -> Option<QuestionReply> {
    let text = raw.get("text")?.as_str()?;
    let list = raw.get("choices")?.as_array()?;
    let mut picked = BTreeSet::new();
    for item in list {
        picked.insert(choice_index(item, target.choices.len())?);
    }
    if target.mode != QuestionMode::Multi && picked.len() > 1 {
        return None;
    }
    if target.permission && picked.len() != 1 {
        return None;
    }
    let text = clip_to(&plain_block(text), QUESTION_REPLY_MAX);
    if picked.is_empty() && text.is_empty() {
        return None;
    }
    Some(QuestionReply {
        choices: picked.into_iter().collect(),
        text,
    })
}
