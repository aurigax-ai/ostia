#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_approvals::approval_answers::{ApprovalKind, offered_answers};
use ostia_approvals::asks::{
    ApprovalRequest, ApprovalText, Approvals, Ask, AskAnswerResult, AskHub, AskHubDeps, AskKind,
    AskResolved, AskTone, OpenApproval, OpenQuestion, PermissionAgent, QuestionPermission,
    QuestionReply, QuestionRequest, Questions, is_phone_approval,
};
use ostia_base::{PaneId, WindowId};
use ostia_contract::capabilities::Capability;
use ostia_control::{IdRegistry, PaneIdentity, PaneInput};
use parking_lot::Mutex;
use serde_json::{Value, json};

#[derive(Default)]
struct FakeQuestions {
    open: Mutex<Vec<OpenQuestion>>,
    replies: Mutex<Vec<(String, QuestionReply)>>,
}

impl Questions for FakeQuestions {
    fn open(&self) -> Vec<OpenQuestion> {
        self.open.lock().clone()
    }

    fn answer(&self, _window_id: &str, ask_id: &str, reply: QuestionReply) -> bool {
        let mut open = self.open.lock();
        let Some(at) = open.iter().position(|item| item.request.id == ask_id) else {
            return false;
        };
        open.remove(at);
        self.replies.lock().push((ask_id.to_owned(), reply));
        true
    }
}

#[derive(Default)]
struct FakeApprovals {
    open: Mutex<Vec<OpenApproval>>,
    answers: Mutex<Vec<(String, Option<Value>)>>,
}

impl Approvals for FakeApprovals {
    fn open(&self) -> Vec<OpenApproval> {
        self.open.lock().clone()
    }

    fn answer(&self, _window_id: &str, ask_id: &str, choice: Option<&Value>) -> bool {
        let mut open = self.open.lock();
        let Some(at) = open.iter().position(|item| item.request.id == ask_id) else {
            return false;
        };
        open.remove(at);
        self.answers
            .lock()
            .push((ask_id.to_owned(), choice.cloned()));
        true
    }
}

fn english() -> ApprovalText {
    ApprovalText {
        allow_once: "Allow once".to_owned(),
        allow_session: "Allow for this pane".to_owned(),
        allow_always: "Always allow".to_owned(),
        allow_workspace: "Allow for this workspace".to_owned(),
        deny: "Deny".to_owned(),
    }
}

fn chinese() -> ApprovalText {
    ApprovalText {
        allow_once: "允許一次".to_owned(),
        allow_session: "允許此窗格".to_owned(),
        allow_always: "永遠允許".to_owned(),
        allow_workspace: "允許此工作區".to_owned(),
        deny: "拒絕".to_owned(),
    }
}

struct Rig {
    pane: PaneIdentity,
    questions: Arc<FakeQuestions>,
    approvals: Arc<FakeApprovals>,
    created: Arc<Mutex<Vec<Ask>>>,
    resolved: Arc<Mutex<Vec<AskResolved>>>,
    hub: AskHub,
}

impl Rig {
    fn new() -> Self {
        Self::with_text(english())
    }

    fn with_text(text: ApprovalText) -> Self {
        let pane = IdRegistry::new(&[1; 32]).register_pane(PaneInput {
            window_id: WindowId::new("7"),
            workspace_id: "ws-asks".into(),
            pane_id: PaneId::new("p-asks"),
        });
        let questions = Arc::new(FakeQuestions::default());
        let approvals = Arc::new(FakeApprovals::default());
        let created = Arc::new(Mutex::new(Vec::new()));
        let resolved = Arc::new(Mutex::new(Vec::new()));
        let known = pane.clone();
        let hub = AskHub::new(AskHubDeps {
            text: Box::new(move || text.clone()),
            questions: {
                let questions = Arc::clone(&questions);
                Box::new(move || Some(Arc::clone(&questions) as Arc<dyn Questions>))
            },
            approvals: {
                let approvals = Arc::clone(&approvals);
                Box::new(move || Some(Arc::clone(&approvals) as Arc<dyn Approvals>))
            },
            identity: Box::new(move |pane_id| (pane_id == "p-asks").then(|| known.clone())),
            created: {
                let created = Arc::clone(&created);
                Box::new(move |ask| created.lock().push(ask.clone()))
            },
            resolved: {
                let resolved = Arc::clone(&resolved);
                Box::new(move |done| resolved.lock().push(done.clone()))
            },
        });
        Self {
            pane,
            questions,
            approvals,
            created,
            resolved,
            hub,
        }
    }

    fn open_question(&self, request: QuestionRequest) {
        self.hub.question_opened(&request);
        self.questions.open.lock().push(OpenQuestion {
            request,
            window_id: "7".to_owned(),
        });
    }

    fn open_approval(&self, request: ApprovalRequest) {
        self.hub.approval_opened(&request);
        self.approvals.open.lock().push(OpenApproval {
            request,
            window_id: "7".to_owned(),
        });
    }
}

fn question(id: &str) -> QuestionRequest {
    QuestionRequest {
        id: id.to_owned(),
        pane_id: "p-asks".to_owned(),
        question: "Which database?".to_owned(),
        context: "Adding the refunds table".to_owned(),
        choices: vec!["staging".to_owned(), "production".to_owned()],
        at: 1000,
        permission: None,
        source_workspace: None,
    }
}

fn permission(id: &str) -> QuestionRequest {
    QuestionRequest {
        id: id.to_owned(),
        pane_id: "p-asks".to_owned(),
        question: "Bash: rm -rf node_modules".to_owned(),
        context: "rm -rf node_modules".to_owned(),
        choices: vec!["once".to_owned(), "always".to_owned(), "deny".to_owned()],
        at: 1000,
        permission: Some(QuestionPermission {
            agent: PermissionAgent::Claude,
        }),
        source_workspace: None,
    }
}

fn approval(id: &str, caps: Vec<Capability>, kind: Option<ApprovalKind>) -> ApprovalRequest {
    ApprovalRequest {
        id: id.to_owned(),
        kind,
        pane_id: "p-asks".to_owned(),
        caps,
        action: "command.exec agent.resume".to_owned(),
        detail: "{}".to_owned(),
        at: 2000,
    }
}

fn labels(ask: &Ask) -> Vec<&str> {
    ask.choices
        .iter()
        .map(|choice| choice.label.as_str())
        .collect()
}

fn ids(ask: &Ask) -> Vec<&str> {
    ask.choices
        .iter()
        .map(|choice| choice.id.as_str())
        .collect()
}

#[test]
fn list_shapes_a_question_an_approval_and_a_permission_request_by_age() {
    let rig = Rig::new();
    rig.open_question(question("question-1"));
    rig.open_question(permission("question-2"));
    rig.open_approval(approval("approval-1", vec![Capability::Shell], None));
    let asks = rig.hub.list();
    assert_eq!(
        asks.iter().map(|ask| ask.kind).collect::<Vec<_>>(),
        [AskKind::Question, AskKind::Permission, AskKind::Approval]
    );
    let external = rig.pane.external_id.to_string();

    let asked = &asks[0];
    assert_eq!(asked.ask_id, "question-1");
    assert_eq!(asked.session_id, "ws-asks");
    assert_eq!(asked.pane_id, external);
    assert_eq!(asked.title, "Which database?");
    assert_eq!(asked.detail.as_deref(), Some("Adding the refunds table"));
    assert_eq!(ids(asked), ["0", "1"]);
    assert_eq!(labels(asked), ["staging", "production"]);
    assert!(asked.choices.iter().all(|c| c.tone == AskTone::Neutral));
    assert!(asked.allow_text);
    assert_eq!(asked.since, 1000);
    assert_eq!(asked.agent, None);

    let permitted = &asks[1];
    assert_eq!(permitted.agent, Some(PermissionAgent::Claude));
    assert_eq!(permitted.title, "Bash: rm -rf node_modules");
    assert_eq!(ids(permitted), ["once", "always", "deny"]);
    assert_eq!(labels(permitted), ["Allow once", "Always allow", "Deny"]);
    assert_eq!(
        permitted.choices.iter().map(|c| c.tone).collect::<Vec<_>>(),
        [AskTone::Primary, AskTone::Neutral, AskTone::Danger]
    );
    assert!(!permitted.allow_text);

    let approved = &asks[2];
    assert_eq!(approved.ask_id, "approval-1");
    assert_eq!(approved.title, "command.exec agent.resume");
    assert_eq!(approved.detail.as_deref(), Some("{}"));
    assert_eq!(ids(approved), ["once", "session", "always", "deny"]);
    assert_eq!(approved.since, 2000);
    assert_eq!(rig.created.lock().len(), 3);
}

#[test]
fn a_listed_ask_serialises_without_its_empty_parts() {
    let rig = Rig::new();
    let mut bare = question("question-1");
    bare.context = String::new();
    rig.open_question(bare);
    let value = serde_json::to_value(&rig.hub.list()[0]).unwrap();
    assert_eq!(
        value,
        json!({
            "askId": "question-1",
            "sessionId": "ws-asks",
            "paneId": rig.pane.external_id.to_string(),
            "kind": "question",
            "title": "Which database?",
            "choices": [
                {"id": "0", "label": "staging", "tone": "neutral"},
                {"id": "1", "label": "production", "tone": "neutral"},
            ],
            "allowText": true,
            "since": 1000,
        })
    );
}

#[test]
fn list_labels_the_answers_in_the_language_the_app_shows() {
    let rig = Rig::with_text(chinese());
    rig.open_approval(approval("approval-1", vec![Capability::Shell], None));
    rig.open_question(permission("question-1"));
    let shown: Vec<Vec<String>> = rig
        .hub
        .list()
        .iter()
        .map(|ask| labels(ask).into_iter().map(str::to_owned).collect())
        .collect();
    assert_eq!(
        shown,
        [
            vec!["允許一次", "永遠允許", "拒絕"],
            vec!["允許一次", "允許此窗格", "永遠允許", "拒絕"],
        ]
    );
}

#[test]
fn answer_routes_a_question_choice_and_text_to_the_questions() {
    let rig = Rig::new();
    rig.open_question(question("question-1"));
    let result = rig.hub.answer(
        "question-1",
        Some(&json!("1")),
        Some(&json!("after the backup")),
    );
    assert_eq!(result, AskAnswerResult::Ok);
    assert_eq!(
        rig.questions.replies.lock().clone(),
        [(
            "question-1".to_owned(),
            QuestionReply {
                choices: vec![1],
                text: "after the backup".to_owned()
            }
        )]
    );
}

#[test]
fn answer_routes_an_approval_to_the_approvals() {
    let rig = Rig::new();
    rig.open_approval(approval("approval-1", vec![Capability::Shell], None));
    let result = rig.hub.answer("approval-1", Some(&json!("session")), None);
    assert_eq!(result, AskAnswerResult::Ok);
    assert_eq!(
        rig.approvals.answers.lock().clone(),
        [("approval-1".to_owned(), Some(json!("session")))]
    );
}

#[test]
fn answer_routes_a_permission_request_by_label_and_drops_the_text() {
    let rig = Rig::new();
    rig.open_question(permission("question-1"));
    let result = rig.hub.answer(
        "question-1",
        Some(&json!("always")),
        Some(&json!("ignored")),
    );
    assert_eq!(result, AskAnswerResult::Ok);
    assert_eq!(
        rig.questions.replies.lock().clone(),
        [(
            "question-1".to_owned(),
            QuestionReply {
                choices: vec![1],
                text: String::new()
            }
        )]
    );
}

#[test]
fn answers_unknown_ask_once_the_ask_was_answered_and_resolves_it_once() {
    let rig = Rig::new();
    rig.open_question(question("question-1"));
    assert_eq!(
        rig.hub.answer("question-1", Some(&json!("0")), None),
        AskAnswerResult::Ok
    );
    rig.hub.settled("question-1", "answered");
    assert_eq!(
        rig.hub.answer("question-1", Some(&json!("0")), None),
        AskAnswerResult::UnknownAsk
    );
    rig.hub.settled("question-1", "answered");
    assert_eq!(
        rig.resolved.lock().clone(),
        [AskResolved {
            ask_id: "question-1".to_owned(),
            outcome: "answered".to_owned()
        }]
    );
    assert!(rig.hub.list().is_empty());
}

#[test]
fn settling_an_ask_that_was_never_announced_resolves_nothing() {
    let rig = Rig::new();
    rig.hub.settled("question-9", "answered");
    assert!(rig.resolved.lock().is_empty());
}

#[test]
fn refuses_a_choice_the_ask_does_not_offer() {
    let rig = Rig::new();
    rig.open_question(permission("question-1"));
    assert_eq!(
        rig.hub.answer("question-1", Some(&json!("forever")), None),
        AskAnswerResult::InvalidAnswer
    );
    rig.open_question(question("question-2"));
    for bad in [json!("2"), json!("-1"), json!("1.5"), json!(""), json!(1)] {
        assert_eq!(
            rig.hub.answer("question-2", Some(&bad), None),
            AskAnswerResult::InvalidAnswer,
            "{bad}"
        );
    }
    assert_eq!(
        rig.hub
            .answer("question-2", Some(&json!("0")), Some(&json!(5))),
        AskAnswerResult::InvalidAnswer
    );
    assert!(rig.questions.replies.lock().is_empty());
}

#[test]
fn answers_a_question_with_text_only() {
    let rig = Rig::new();
    rig.open_question(question("question-1"));
    assert_eq!(
        rig.hub
            .answer("question-1", None, Some(&json!("free text"))),
        AskAnswerResult::Ok
    );
    assert_eq!(
        rig.questions.replies.lock()[0].1,
        QuestionReply {
            choices: Vec::new(),
            text: "free text".to_owned()
        }
    );
}

#[test]
fn never_lists_a_sandbox_card_which_only_the_desktop_answers() {
    let rig = Rig::new();
    rig.open_approval(approval(
        "approval-1",
        Vec::new(),
        Some(ApprovalKind::SandboxDomain),
    ));
    assert!(rig.created.lock().is_empty());
    assert!(rig.hub.list().is_empty());
    assert_eq!(
        rig.hub.answer("approval-1", Some(&json!("once")), None),
        AskAnswerResult::UnknownAsk
    );
}

#[test]
fn keeps_destructive_and_credentials_cards_on_the_desktop() {
    for cap in [Capability::Destructive, Capability::Credentials] {
        let rig = Rig::new();
        rig.open_approval(approval("approval-1", vec![cap], None));
        assert!(rig.hub.list().is_empty(), "{cap:?}");
        assert!(rig.created.lock().is_empty(), "{cap:?}");
        assert_eq!(
            rig.hub.answer("approval-1", Some(&json!("once")), None),
            AskAnswerResult::UnknownAsk,
            "{cap:?}"
        );
        assert_eq!(rig.approvals.open.lock().len(), 1, "{cap:?}");
    }
}

#[test]
fn a_phone_approval_is_a_capability_card_with_no_always_ask_capability() {
    let plain = approval("a", vec![Capability::Shell, Capability::Browse], None);
    assert!(is_phone_approval(&plain));
    assert!(is_phone_approval(&approval(
        "a",
        Vec::new(),
        Some(ApprovalKind::Capability)
    )));
    assert!(!is_phone_approval(&approval(
        "a",
        vec![Capability::Shell, Capability::Destructive],
        None
    )));
    assert!(!is_phone_approval(&approval(
        "a",
        vec![Capability::Credentials],
        None
    )));
    assert!(!is_phone_approval(&approval(
        "a",
        Vec::new(),
        Some(ApprovalKind::Secret)
    )));
}

#[test]
fn an_always_ask_capability_offers_no_standing_answer() {
    use ostia_approvals::approval_answers::ApprovalAnswer::{Deny, Once};
    assert_eq!(
        offered_answers(ApprovalKind::Capability, &[Capability::Destructive]),
        [Once, Deny]
    );
}

#[test]
fn an_ask_from_an_extension_belongs_to_its_workspace_and_no_pane() {
    let rig = Rig::new();
    let mut request = question("question-1");
    request.pane_id = "none".to_owned();
    request.source_workspace = Some("ws-ext".into());
    rig.open_question(request);
    let ask = &rig.hub.list()[0];
    assert_eq!(ask.session_id, "ws-ext");
    assert_eq!(ask.pane_id, "");
}

#[test]
fn an_ask_for_a_pane_nobody_knows_is_not_listed() {
    let rig = Rig::new();
    let mut request = question("question-1");
    request.pane_id = "p-gone".to_owned();
    rig.open_question(request);
    assert!(rig.hub.list().is_empty());
    assert!(rig.created.lock().is_empty());
}
