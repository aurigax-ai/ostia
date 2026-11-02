#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use ostia_agents::agent_offer_relay::{
    AGENT_OFFER_CHANNEL, AGENT_OFFER_TIMEOUT_MS, AGENT_OFFER_WITHDRAWN_CHANNEL, AgentOffer,
    AgentOfferDelivery, AgentOfferRelay, AgentOfferRelayDeps,
};
use ostia_base::{WindowId, WorkspaceId};
use parking_lot::Mutex;
use serde_json::{Value, json};

type Sent = Arc<Mutex<Vec<(WindowId, String, Value)>>>;

fn offer() -> AgentOffer {
    AgentOffer {
        ext_id: "trellis".to_owned(),
        ext_name: "Trellis".to_owned(),
        workspace_id: WorkspaceId::new("w1"),
        label: "SHOP-7".to_owned(),
        text: "Work on SHOP-7".to_owned(),
    }
}

fn offer_payload(request_id: &str) -> Value {
    json!({
        "extId": "trellis",
        "extName": "Trellis",
        "workspaceId": "w1",
        "label": "SHOP-7",
        "text": "Work on SHOP-7",
        "requestId": request_id,
    })
}

fn relay_with(accepts: bool, timeout: Option<Duration>) -> (AgentOfferRelay, Sent) {
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&sent);
    let relay = AgentOfferRelay::new(AgentOfferRelayDeps {
        window_of: Box::new(|workspace| (workspace.as_str() == "w1").then(|| WindowId::new("7"))),
        send: Box::new(move |window, channel, payload| {
            log.lock()
                .push((window.clone(), channel.to_owned(), payload));
            accepts
        }),
        external_id_of: Box::new(|pane| (pane.as_str() == "pane-1").then(|| "ext-1".to_owned())),
        timeout,
    });
    (relay, sent)
}

fn relay() -> (AgentOfferRelay, Sent) {
    relay_with(true, None)
}

fn start(
    relay: &AgentOfferRelay,
    offer: AgentOffer,
) -> tokio::task::JoinHandle<AgentOfferDelivery> {
    let relay = relay.clone();
    tokio::spawn(async move { relay.offer(offer).await })
}

fn answer(relay: &AgentOfferRelay, window: &str, request_id: Value, pane: Value) {
    relay.answer(&WindowId::new(window), &request_id, &pane);
}

fn delivered(pane_id: Option<&str>) -> AgentOfferDelivery {
    AgentOfferDelivery::Delivered {
        pane_id: pane_id.map(str::to_owned),
    }
}

#[tokio::test(start_paused = true)]
async fn shows_the_offer_only_in_the_window_that_holds_the_workspace() {
    let (r, sent) = relay();
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    assert_eq!(
        *sent.lock(),
        vec![(
            WindowId::new("7"),
            AGENT_OFFER_CHANNEL.to_owned(),
            offer_payload("offer-1")
        )]
    );
    answer(&r, "7", json!("offer-1"), json!("pane-1"));
    assert_eq!(pending.await.unwrap(), delivered(Some("ext-1")));
}

#[tokio::test(start_paused = true)]
async fn ignores_an_answer_from_another_window_or_for_another_request() {
    let (r, _sent) = relay();
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    answer(&r, "8", json!("offer-1"), json!("pane-1"));
    answer(&r, "7", json!("offer-2"), json!("pane-1"));
    answer(&r, "7", json!(42), json!("pane-1"));
    assert!(!pending.is_finished());
    answer(&r, "7", json!("offer-1"), Value::Null);
    assert_eq!(pending.await.unwrap(), delivered(None));
}

#[tokio::test(start_paused = true)]
async fn reports_a_pane_main_does_not_know_as_not_sent() {
    let (r, _sent) = relay();
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    answer(&r, "7", json!("offer-1"), json!("pane-unknown"));
    assert_eq!(pending.await.unwrap(), delivered(None));
}

#[tokio::test(start_paused = true)]
async fn is_not_delivered_when_no_window_holds_the_workspace() {
    let (r, sent) = relay();
    let gone = AgentOffer {
        workspace_id: WorkspaceId::new("gone"),
        ..offer()
    };
    assert_eq!(r.offer(gone).await, AgentOfferDelivery::NotDelivered);
    assert!(sent.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn withdraws_an_unanswered_offer_after_the_timeout() {
    let (r, sent) = relay();
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(AGENT_OFFER_TIMEOUT_MS)).await;
    assert_eq!(pending.await.unwrap(), delivered(None));
    assert_eq!(
        sent.lock().last().cloned().unwrap(),
        (
            WindowId::new("7"),
            AGENT_OFFER_WITHDRAWN_CHANNEL.to_owned(),
            json!("offer-1")
        )
    );
    answer(&r, "7", json!("offer-1"), json!("pane-1"));
}

#[tokio::test(start_paused = true)]
async fn waits_the_full_timeout_before_it_withdraws() {
    let (r, sent) = relay();
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(AGENT_OFFER_TIMEOUT_MS - 1)).await;
    tokio::task::yield_now().await;
    assert!(!pending.is_finished());
    assert_eq!(sent.lock().len(), 1);
    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(pending.await.unwrap(), delivered(None));
}

#[tokio::test(start_paused = true)]
async fn uses_the_timeout_it_is_given() {
    let (r, sent) = relay_with(true, Some(Duration::from_millis(50)));
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(50)).await;
    assert_eq!(pending.await.unwrap(), delivered(None));
    assert_eq!(sent.lock().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn is_not_delivered_when_the_window_refuses_the_offer() {
    let (r, sent) = relay_with(false, None);
    assert_eq!(r.offer(offer()).await, AgentOfferDelivery::NotDelivered);
    assert_eq!(sent.lock().len(), 1);
    tokio::time::advance(Duration::from_millis(AGENT_OFFER_TIMEOUT_MS)).await;
    assert_eq!(sent.lock().len(), 1);
    answer(&r, "7", json!("offer-1"), json!("pane-1"));
}

#[tokio::test(start_paused = true)]
async fn numbers_each_offer_and_answers_them_one_by_one() {
    let (r, sent) = relay();
    let first = start(&r, offer());
    let second = start(&r, offer());
    tokio::task::yield_now().await;
    assert_eq!(sent.lock()[0].2["requestId"], json!("offer-1"));
    assert_eq!(sent.lock()[1].2["requestId"], json!("offer-2"));
    answer(&r, "7", json!("offer-2"), json!("pane-1"));
    assert_eq!(second.await.unwrap(), delivered(Some("ext-1")));
    assert!(!first.is_finished());
    answer(&r, "7", json!("offer-1"), json!("pane-1"));
    assert_eq!(first.await.unwrap(), delivered(Some("ext-1")));
}

#[tokio::test(start_paused = true)]
async fn treats_an_empty_pane_id_as_no_pane() {
    let (r, _sent) = relay();
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    answer(&r, "7", json!("offer-1"), json!(""));
    assert_eq!(pending.await.unwrap(), delivered(None));
}

#[tokio::test(start_paused = true)]
async fn ignores_a_second_answer_to_the_same_offer() {
    let (r, sent) = relay();
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    answer(&r, "7", json!("offer-1"), json!("pane-1"));
    answer(&r, "7", json!("offer-1"), json!("pane-1"));
    assert_eq!(pending.await.unwrap(), delivered(Some("ext-1")));
    tokio::time::advance(Duration::from_millis(AGENT_OFFER_TIMEOUT_MS)).await;
    assert_eq!(sent.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn withdraws_the_offer_and_frees_the_request_when_the_future_is_dropped() {
    let (r, sent) = relay();
    let future = r.offer(offer());
    drop(future);
    assert_eq!(
        *sent.lock(),
        vec![
            (
                WindowId::new("7"),
                AGENT_OFFER_CHANNEL.to_owned(),
                offer_payload("offer-1")
            ),
            (
                WindowId::new("7"),
                AGENT_OFFER_WITHDRAWN_CHANNEL.to_owned(),
                json!("offer-1")
            ),
        ]
    );
    answer(&r, "7", json!("offer-1"), json!("pane-1"));
    assert_eq!(sent.lock().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn does_not_send_a_withdrawal_for_an_offer_that_was_answered() {
    let (r, sent) = relay();
    let pending = start(&r, offer());
    tokio::task::yield_now().await;
    answer(&r, "7", json!("offer-1"), json!("pane-1"));
    pending.await.unwrap();
    assert_eq!(sent.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn does_not_deliver_to_a_window_with_an_empty_id() {
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&sent);
    let r = AgentOfferRelay::new(AgentOfferRelayDeps {
        window_of: Box::new(|_| Some(WindowId::new(""))),
        send: Box::new(move |window, channel, payload| {
            log.lock()
                .push((window.clone(), channel.to_owned(), payload));
            true
        }),
        external_id_of: Box::new(|_| None),
        timeout: None,
    });
    assert_eq!(r.offer(offer()).await, AgentOfferDelivery::NotDelivered);
    assert!(sent.lock().is_empty());
}
