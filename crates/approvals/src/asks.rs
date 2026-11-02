use std::collections::HashSet;
use std::sync::Arc;

use ostia_base::WorkspaceId;
use ostia_contract::capabilities::Capability;
use ostia_control::PaneIdentity;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::approval_answers::{ApprovalAnswer, ApprovalKind, asks_always, offered_answers};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AskKind {
    Permission,
    Question,
    Approval,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AskTone {
    Primary,
    Neutral,
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionAgent {
    Claude,
    Codex,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AskChoice {
    pub id: String,
    pub label: String,
    pub tone: AskTone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub ask_id: String,
    pub session_id: String,
    pub pane_id: String,
    pub kind: AskKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<PermissionAgent>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub choices: Vec<AskChoice>,
    pub allow_text: bool,
    pub since: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskResolved {
    pub ask_id: String,
    pub outcome: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskAnswerResult {
    Ok,
    UnknownAsk,
    InvalidAnswer,
}

impl AskAnswerResult {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::UnknownAsk => "unknown-ask",
            Self::InvalidAnswer => "invalid-answer",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalText {
    pub allow_once: String,
    pub allow_session: String,
    pub allow_always: String,
    pub allow_workspace: String,
    pub deny: String,
}

impl ApprovalText {
    fn label(&self, answer: ApprovalAnswer) -> &str {
        match answer {
            ApprovalAnswer::Once => &self.allow_once,
            ApprovalAnswer::Session => &self.allow_session,
            ApprovalAnswer::Always => &self.allow_always,
            ApprovalAnswer::Workspace => &self.allow_workspace,
            ApprovalAnswer::Deny => &self.deny,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionPermission {
    pub agent: PermissionAgent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionRequest {
    pub id: String,
    pub pane_id: String,
    pub question: String,
    pub context: String,
    pub choices: Vec<String>,
    pub at: i64,
    pub permission: Option<QuestionPermission>,
    pub source_workspace: Option<WorkspaceId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub id: String,
    pub kind: Option<ApprovalKind>,
    pub pane_id: String,
    pub caps: Vec<Capability>,
    pub action: String,
    pub detail: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionReply {
    pub choices: Vec<usize>,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenQuestion {
    pub request: QuestionRequest,
    pub window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenApproval {
    pub request: ApprovalRequest,
    pub window_id: String,
}

pub trait Questions: Send + Sync {
    fn open(&self) -> Vec<OpenQuestion>;
    fn answer(&self, window_id: &str, ask_id: &str, reply: QuestionReply) -> bool;
}

pub trait Approvals: Send + Sync {
    fn open(&self) -> Vec<OpenApproval>;
    fn answer(&self, window_id: &str, ask_id: &str, choice: Option<&Value>) -> bool;
}

pub type QuestionsSource = Box<dyn Fn() -> Option<Arc<dyn Questions>> + Send + Sync>;
pub type ApprovalsSource = Box<dyn Fn() -> Option<Arc<dyn Approvals>> + Send + Sync>;

pub struct AskHubDeps {
    pub text: Box<dyn Fn() -> ApprovalText + Send + Sync>,
    pub questions: QuestionsSource,
    pub approvals: ApprovalsSource,
    pub identity: Box<dyn Fn(&str) -> Option<PaneIdentity> + Send + Sync>,
    pub created: Box<dyn Fn(&Ask) + Send + Sync>,
    pub resolved: Box<dyn Fn(&AskResolved) + Send + Sync>,
}

pub struct AskHub {
    deps: AskHubDeps,
    shown: Mutex<HashSet<String>>,
}

const PERMISSION_ANSWERS: [ApprovalAnswer; 3] = [
    ApprovalAnswer::Once,
    ApprovalAnswer::Always,
    ApprovalAnswer::Deny,
];

fn answer_tone(answer: ApprovalAnswer) -> AskTone {
    match answer {
        ApprovalAnswer::Once => AskTone::Primary,
        ApprovalAnswer::Session | ApprovalAnswer::Always | ApprovalAnswer::Workspace => {
            AskTone::Neutral
        }
        ApprovalAnswer::Deny => AskTone::Danger,
    }
}

fn answer_choice(answer: ApprovalAnswer, text: &ApprovalText) -> AskChoice {
    AskChoice {
        id: answer.id().to_owned(),
        label: text.label(answer).to_owned(),
        tone: answer_tone(answer),
    }
}

pub fn is_phone_approval(request: &ApprovalRequest) -> bool {
    request.kind.unwrap_or_default() == ApprovalKind::Capability && !asks_always(&request.caps)
}

fn non_empty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_owned())
}

struct AskPlace {
    workspace_id: String,
    external_id: String,
}

fn question_ask(request: &QuestionRequest, at: AskPlace, text: &ApprovalText) -> Ask {
    let base = |kind, choices, allow_text, agent| Ask {
        ask_id: request.id.clone(),
        session_id: at.workspace_id.clone(),
        pane_id: at.external_id.clone(),
        kind,
        agent,
        title: request.question.clone(),
        detail: non_empty(&request.context),
        choices,
        allow_text,
        since: request.at,
    };
    if let Some(permission) = &request.permission {
        let choices = request
            .choices
            .iter()
            .filter_map(|id| ApprovalAnswer::parse(id))
            .filter(|answer| PERMISSION_ANSWERS.contains(answer))
            .map(|answer| answer_choice(answer, text))
            .collect();
        return base(AskKind::Permission, choices, false, Some(permission.agent));
    }
    let choices = request
        .choices
        .iter()
        .enumerate()
        .map(|(index, label)| AskChoice {
            id: index.to_string(),
            label: label.clone(),
            tone: AskTone::Neutral,
        })
        .collect();
    base(AskKind::Question, choices, true, None)
}

fn approval_ask(request: &ApprovalRequest, identity: &PaneIdentity, text: &ApprovalText) -> Ask {
    Ask {
        ask_id: request.id.clone(),
        session_id: identity.workspace_id.to_string(),
        pane_id: identity.external_id.to_string(),
        kind: AskKind::Approval,
        agent: None,
        title: request.action.clone(),
        detail: non_empty(&request.detail),
        choices: offered_answers(request.kind.unwrap_or_default(), &request.caps)
            .into_iter()
            .map(|answer| answer_choice(answer, text))
            .collect(),
        allow_text: false,
        since: request.at,
    }
}

fn choice_index(choices: &[String], choice_id: &Value, by_label: bool) -> Option<usize> {
    let id = choice_id.as_str()?;
    if by_label {
        return choices.iter().position(|label| label == id);
    }
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    id.parse::<usize>()
        .ok()
        .filter(|index| *index < choices.len())
}

impl AskHub {
    pub fn new(deps: AskHubDeps) -> Self {
        Self {
            deps,
            shown: Mutex::new(HashSet::new()),
        }
    }

    fn ask_for_question(&self, request: &QuestionRequest) -> Option<Ask> {
        let text = (self.deps.text)();
        if let Some(workspace) = &request.source_workspace {
            let at = AskPlace {
                workspace_id: workspace.to_string(),
                external_id: String::new(),
            };
            return Some(question_ask(request, at, &text));
        }
        let identity = (self.deps.identity)(&request.pane_id)?;
        let at = AskPlace {
            workspace_id: identity.workspace_id.to_string(),
            external_id: identity.external_id.to_string(),
        };
        Some(question_ask(request, at, &text))
    }

    fn ask_for_approval(&self, request: &ApprovalRequest) -> Option<Ask> {
        if !is_phone_approval(request) {
            return None;
        }
        let identity = (self.deps.identity)(&request.pane_id)?;
        Some(approval_ask(request, &identity, &(self.deps.text)()))
    }

    pub fn list(&self) -> Vec<Ask> {
        let questions = (self.deps.questions)()
            .map(|questions| questions.open())
            .unwrap_or_default()
            .into_iter()
            .map(|open| self.ask_for_question(&open.request));
        let approvals = (self.deps.approvals)()
            .map(|approvals| approvals.open())
            .unwrap_or_default()
            .into_iter()
            .map(|open| self.ask_for_approval(&open.request));
        let mut asks: Vec<Ask> = questions.chain(approvals).flatten().collect();
        asks.sort_by_key(|ask| ask.since);
        asks
    }

    fn answer_question(
        &self,
        questions: &dyn Questions,
        ask_id: &str,
        choice_id: Option<&Value>,
        text: Option<&Value>,
    ) -> AskAnswerResult {
        let Some(open) = questions
            .open()
            .into_iter()
            .find(|open| open.request.id == ask_id)
        else {
            return AskAnswerResult::UnknownAsk;
        };
        let permission = open.request.permission.is_some();
        let picked = match choice_id {
            None => None,
            Some(choice_id) => match choice_index(&open.request.choices, choice_id, permission) {
                Some(index) => Some(index),
                None => return AskAnswerResult::InvalidAnswer,
            },
        };
        let typed = match text {
            None => String::new(),
            Some(Value::String(typed)) => typed.clone(),
            Some(_) => return AskAnswerResult::InvalidAnswer,
        };
        let reply = QuestionReply {
            choices: picked.into_iter().collect(),
            text: if permission { String::new() } else { typed },
        };
        if questions.answer(&open.window_id, ask_id, reply) {
            AskAnswerResult::Ok
        } else {
            AskAnswerResult::InvalidAnswer
        }
    }

    fn answer_approval(&self, ask_id: &str, choice_id: Option<&Value>) -> AskAnswerResult {
        let Some(approvals) = (self.deps.approvals)() else {
            return AskAnswerResult::UnknownAsk;
        };
        let Some(open) = approvals
            .open()
            .into_iter()
            .find(|open| open.request.id == ask_id)
            .filter(|open| is_phone_approval(&open.request))
        else {
            return AskAnswerResult::UnknownAsk;
        };
        if approvals.answer(&open.window_id, ask_id, choice_id) {
            AskAnswerResult::Ok
        } else {
            AskAnswerResult::InvalidAnswer
        }
    }

    pub fn answer(
        &self,
        ask_id: &str,
        choice_id: Option<&Value>,
        text: Option<&Value>,
    ) -> AskAnswerResult {
        if let Some(questions) = (self.deps.questions)()
            && questions
                .open()
                .iter()
                .any(|open| open.request.id == ask_id)
        {
            return self.answer_question(questions.as_ref(), ask_id, choice_id, text);
        }
        self.answer_approval(ask_id, choice_id)
    }

    fn announce(&self, ask: Option<Ask>) {
        let Some(ask) = ask else { return };
        self.shown.lock().insert(ask.ask_id.clone());
        (self.deps.created)(&ask);
    }

    pub fn question_opened(&self, request: &QuestionRequest) {
        self.announce(self.ask_for_question(request));
    }

    pub fn approval_opened(&self, request: &ApprovalRequest) {
        self.announce(self.ask_for_approval(request));
    }

    pub fn settled(&self, ask_id: &str, outcome: &str) {
        if !self.shown.lock().remove(ask_id) {
            return;
        }
        (self.deps.resolved)(&AskResolved {
            ask_id: ask_id.to_owned(),
            outcome: outcome.to_owned(),
        });
    }
}
