#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use ostia_gateway::screen_requests::{
    AgentScreenAsk, AskFromAgent, AskRefusal, PhoneScreenAskOutcome, PhoneScreenDeclineReason,
    RequestedBy, ScreenRequestTiming, ScreenRequested, ScreenRequests,
};
use parking_lot::Mutex;
use tokio::sync::oneshot::Receiver;

type Sent = Arc<Mutex<Vec<(ScreenRequested, Vec<String>)>>>;

struct Rig {
    devices: Arc<Mutex<Vec<String>>>,
    sent: Sent,
    clock: Arc<AtomicI64>,
    requests: ScreenRequests,
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn rig() -> Rig {
    let devices = Arc::new(Mutex::new(strings(&["phone", "tablet"])));
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let clock = Arc::new(AtomicI64::new(1_700_000_000_000));
    let requests = ScreenRequests::new(
        {
            let devices = Arc::clone(&devices);
            move || devices.lock().clone()
        },
        {
            let sent = Arc::clone(&sent);
            move |request, ids| sent.lock().push((request, ids))
        },
        {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.load(Ordering::SeqCst))
        },
        ScreenRequestTiming {
            wait_ms: 120_000,
            cooldown_ms: 60_000,
            no_answer_cooldown_ms: 15_000,
        },
    );
    Rig {
        devices,
        sent,
        clock,
        requests,
    }
}

impl Rig {
    fn set_devices(&self, devices: &[&str]) {
        *self.devices.lock() = strings(devices);
    }

    fn ask(&self, session_id: &str) -> AskFromAgent {
        self.requests.ask_from_agent(AgentScreenAsk {
            session_id: session_id.to_owned(),
            reason: Some("check the login".to_owned()),
            agent: None,
            pane: Some("p1".to_owned()),
        })
    }

    fn asked(&self, session_id: &str) -> Receiver<PhoneScreenAskOutcome> {
        match self.ask(session_id) {
            AskFromAgent::Asked(answer) => answer,
            AskFromAgent::Refused(why) => panic!("not asked: {why:?}"),
        }
    }

    fn refused(&self, session_id: &str) -> AskRefusal {
        match self.ask(session_id) {
            AskFromAgent::Refused(why) => why,
            AskFromAgent::Asked(_) => panic!("asked"),
        }
    }

    fn request_id(&self, index: usize) -> String {
        self.sent.lock()[index].0.request_id.clone().unwrap()
    }

    async fn advance(&self, ms: u64) {
        self.clock
            .fetch_add(i64::try_from(ms).unwrap(), Ordering::SeqCst);
        tokio::time::advance(Duration::from_millis(ms)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn pha_c10_answers_no_phone_when_no_phone_can_be_asked_and_asks_only_phones_without_a_waiting_request()
 {
    let rig = rig();
    rig.set_devices(&[]);
    assert_eq!(rig.refused("w1"), AskRefusal::NoPhone);
    rig.set_devices(&["phone"]);
    let _first = rig.asked("w1");
    assert_eq!(rig.refused("w2"), AskRefusal::Busy);
    rig.set_devices(&["phone", "tablet"]);
    let _second = rig.asked("w2");
    let sent: Vec<(String, Vec<String>)> = rig
        .sent
        .lock()
        .iter()
        .map(|(request, ids)| (request.session_id.clone(), ids.clone()))
        .collect();
    assert_eq!(
        sent,
        vec![
            ("w1".to_owned(), strings(&["phone"])),
            ("w2".to_owned(), strings(&["tablet"])),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn pha_c11_starts_on_the_first_matching_phone_declines_only_when_all_asked_phones_did_then_cools_down_for_a_minute()
 {
    let rig = rig();
    let asked = rig.asked("w1");
    let id = rig.request_id(0);
    assert!(
        !rig.requests
            .decline(&id, "stranger", PhoneScreenDeclineReason::Off)
    );
    assert!(
        rig.requests
            .decline(&id, "phone", PhoneScreenDeclineReason::Off)
    );
    rig.requests.started(&id, "tablet", "w2");
    assert!(
        rig.requests
            .decline(&id, "tablet", PhoneScreenDeclineReason::Unsupported)
    );
    assert_eq!(
        asked.await.unwrap(),
        PhoneScreenAskOutcome::Declined {
            reason: PhoneScreenDeclineReason::Off
        }
    );
    assert_eq!(rig.refused("w1"), AskRefusal::Cooldown);
    rig.advance(60_000).await;
    let again = rig.asked("w1");
    let second_id = rig.request_id(1);
    rig.requests.started(&second_id, "tablet", "w1");
    assert_eq!(again.await.unwrap(), PhoneScreenAskOutcome::Started);
}

#[tokio::test(start_paused = true)]
async fn pha_c12_answers_no_answer_after_two_minutes() {
    let rig = rig();
    let asked = rig.asked("w1");
    rig.advance(120_000).await;
    assert_eq!(asked.await.unwrap(), PhoneScreenAskOutcome::NoAnswer);
}

#[tokio::test(start_paused = true)]
async fn pha_c14_drops_a_gone_phone_from_its_waiting_request_at_once() {
    let rig = rig();
    let declined = rig.asked("w1");
    rig.requests.decline(
        &rig.request_id(0),
        "phone",
        PhoneScreenDeclineReason::Denied,
    );
    rig.requests.drop_device("stranger");
    rig.requests.drop_device("tablet");
    assert_eq!(
        declined.await.unwrap(),
        PhoneScreenAskOutcome::Declined {
            reason: PhoneScreenDeclineReason::Denied
        }
    );
    rig.set_devices(&["phone"]);
    let alone = rig.asked("w2");
    rig.requests.drop_device("phone");
    assert_eq!(alone.await.unwrap(), PhoneScreenAskOutcome::NoAnswer);
}

#[tokio::test(start_paused = true)]
async fn pha_c15_cools_down_briefly_after_no_answer_and_forgets_cooldowns_that_ended() {
    let rig = rig();
    let _asked = rig.asked("w1");
    rig.advance(120_000).await;
    assert_eq!(rig.refused("w1"), AskRefusal::Cooldown);
    assert_eq!(rig.requests.cooling_sessions(), vec!["w1".to_owned()]);
    rig.advance(15_000).await;
    let _second = rig.asked("w2");
    assert!(rig.requests.cooling_sessions().is_empty());
}

#[tokio::test(start_paused = true)]
async fn sends_the_request_with_its_origin_reason_pane_and_a_fresh_request_id() {
    let rig = rig();
    let _first = rig.asked("w1");
    rig.set_devices(&["phone", "tablet", "watch"]);
    let _second = rig.asked("w2");
    let sent = rig.sent.lock();
    let (request, ids) = &sent[0];
    assert_eq!(request.by, RequestedBy::Agent);
    assert_eq!(request.session_id, "w1");
    assert_eq!(request.reason.as_deref(), Some("check the login"));
    assert_eq!(request.pane.as_deref(), Some("p1"));
    assert_eq!(ids, &strings(&["phone", "tablet"]));
    let first_id = request.request_id.clone().unwrap();
    assert!(uuid::Uuid::parse_str(&first_id).is_ok(), "{first_id}");
    assert_ne!(sent[1].0.request_id.clone().unwrap(), first_id);
    assert_eq!(sent[1].1, strings(&["watch"]));
}

#[tokio::test(start_paused = true)]
async fn answers_busy_for_a_session_that_already_has_a_waiting_request() {
    let rig = rig();
    let _first = rig.asked("w1");
    assert_eq!(rig.refused("w1"), AskRefusal::Busy);
    assert_eq!(rig.sent.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn declines_with_denied_before_off_before_unsupported() {
    let table = [
        (
            PhoneScreenDeclineReason::Off,
            PhoneScreenDeclineReason::Unsupported,
            PhoneScreenDeclineReason::Off,
        ),
        (
            PhoneScreenDeclineReason::Unsupported,
            PhoneScreenDeclineReason::Denied,
            PhoneScreenDeclineReason::Denied,
        ),
        (
            PhoneScreenDeclineReason::Off,
            PhoneScreenDeclineReason::Denied,
            PhoneScreenDeclineReason::Denied,
        ),
        (
            PhoneScreenDeclineReason::Unsupported,
            PhoneScreenDeclineReason::Unsupported,
            PhoneScreenDeclineReason::Unsupported,
        ),
    ];
    for (phone, tablet, expected) in table {
        let rig = rig();
        let asked = rig.asked("w1");
        let id = rig.request_id(0);
        rig.requests.decline(&id, "phone", phone);
        rig.requests.decline(&id, "tablet", tablet);
        assert_eq!(
            asked.await.unwrap(),
            PhoneScreenAskOutcome::Declined { reason: expected },
            "{phone:?} {tablet:?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn ignores_started_from_a_phone_that_was_not_asked_a_wrong_session_or_an_unknown_request() {
    let rig = rig();
    let mut asked = rig.asked("w1");
    let id = rig.request_id(0);
    rig.requests.started(&id, "stranger", "w1");
    rig.requests.started(&id, "phone", "w2");
    rig.requests.started("unknown", "phone", "w1");
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    assert!(asked.try_recv().is_err());
    rig.requests.started(&id, "phone", "w1");
    assert_eq!(asked.await.unwrap(), PhoneScreenAskOutcome::Started);
}

#[tokio::test(start_paused = true)]
async fn settles_a_request_once_and_refuses_a_decline_after_it_settled() {
    let rig = rig();
    let asked = rig.asked("w1");
    let id = rig.request_id(0);
    rig.requests.started(&id, "phone", "w1");
    assert!(
        !rig.requests
            .decline(&id, "tablet", PhoneScreenDeclineReason::Off)
    );
    assert_eq!(asked.await.unwrap(), PhoneScreenAskOutcome::Started);
}

#[tokio::test(start_paused = true)]
async fn a_started_request_sets_no_cooldown_and_its_timer_is_gone() {
    let rig = rig();
    let asked = rig.asked("w1");
    rig.requests.started(&rig.request_id(0), "phone", "w1");
    assert_eq!(asked.await.unwrap(), PhoneScreenAskOutcome::Started);
    assert!(rig.requests.cooling_sessions().is_empty());
    rig.advance(120_000).await;
    assert!(rig.requests.cooling_sessions().is_empty());
    let _again = rig.asked("w1");
}

#[tokio::test(start_paused = true)]
async fn drops_a_gone_phone_and_declines_when_every_phone_left_has_declined() {
    let rig = rig();
    let asked = rig.asked("w1");
    rig.requests.decline(
        &rig.request_id(0),
        "phone",
        PhoneScreenDeclineReason::Unsupported,
    );
    rig.requests.drop_device("tablet");
    assert_eq!(
        asked.await.unwrap(),
        PhoneScreenAskOutcome::Declined {
            reason: PhoneScreenDeclineReason::Unsupported
        }
    );
    assert_eq!(rig.refused("w1"), AskRefusal::Cooldown);
}

#[tokio::test(start_paused = true)]
async fn waits_the_whole_two_minutes_before_it_answers_no_answer() {
    let rig = rig();
    let mut asked = rig.asked("w1");
    rig.advance(119_999).await;
    assert!(asked.try_recv().is_err());
    rig.advance(1).await;
    assert_eq!(asked.await.unwrap(), PhoneScreenAskOutcome::NoAnswer);
}

#[test]
fn waits_two_minutes_and_cools_down_a_minute_after_a_decline_and_fifteen_seconds_after_no_answer_by_default()
 {
    assert_eq!(
        ScreenRequestTiming::default(),
        ScreenRequestTiming {
            wait_ms: 120_000,
            cooldown_ms: 60_000,
            no_answer_cooldown_ms: 15_000,
        }
    );
}
