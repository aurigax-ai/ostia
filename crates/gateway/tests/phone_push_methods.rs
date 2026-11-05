#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::VecDeque;

use ostia_gateway::push::phone_push_methods::{
    PhonePushPort, RegisterError, TicketError, push_register, push_ticket, push_unregister,
};
use ostia_gateway::rpc_outcome::RpcOutcome;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

type Registered = (String, Option<Value>, Option<Value>);

#[derive(Default)]
struct FakePush {
    tickets: Mutex<VecDeque<Result<(String, i64), TicketError>>>,
    registers: Mutex<VecDeque<Result<(), RegisterError>>>,
    unregister_result: Value,
    ticket_calls: Mutex<Vec<String>>,
    register_calls: Mutex<Vec<Registered>>,
    unregister_calls: Mutex<Vec<String>>,
}

impl PhonePushPort for FakePush {
    async fn ticket(&self, device_id: &str) -> Result<(String, i64), TicketError> {
        self.ticket_calls.lock().push(device_id.to_owned());
        self.tickets.lock().pop_front().unwrap()
    }

    fn register(
        &self,
        device_id: &str,
        handle: Option<&Value>,
        platform: Option<&Value>,
    ) -> Result<(), RegisterError> {
        self.register_calls
            .lock()
            .push((device_id.to_owned(), handle.cloned(), platform.cloned()));
        self.registers.lock().pop_front().unwrap()
    }

    fn unregister(&self, device_id: &str) -> Value {
        self.unregister_calls.lock().push(device_id.to_owned());
        self.unregister_result.clone()
    }
}

fn refused(code: i64, message: &str) -> RpcOutcome {
    RpcOutcome::Refused {
        code,
        message: message.to_owned(),
        data: None,
    }
}

fn params(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[tokio::test]
async fn psh_c38_answers_push_ticket_with_the_ticket_and_its_expiry() {
    let push = FakePush::default();
    push.tickets.lock().push_back(Ok(("tk".to_owned(), 9)));
    let out = push_ticket("dev_1", &push).await;
    assert_eq!(out, RpcOutcome::Ok(json!({"ticket": "tk", "expiresAt": 9})));
    assert_eq!(*push.ticket_calls.lock(), vec!["dev_1".to_owned()]);
}

#[tokio::test]
async fn psh_c39_maps_a_refused_ticket_to_push_off_rate_limited_and_server_unavailable() {
    let table = [
        (TicketError::PushOff, refused(-32602, "push-off")),
        (TicketError::RateLimited, refused(-32007, "rate-limited")),
        (
            TicketError::ServerUnavailable,
            refused(-32603, "server-unavailable"),
        ),
    ];
    for (error, expected) in table {
        let push = FakePush::default();
        push.tickets.lock().push_back(Err(error));
        assert_eq!(push_ticket("dev_1", &push).await, expected, "{error:?}");
    }
}

#[test]
fn psh_c40_passes_push_register_its_handle_and_platform_and_answers_ok_push_off_or_bad_params() {
    let push = FakePush::default();
    {
        let mut queue = push.registers.lock();
        queue.push_back(Ok(()));
        queue.push_back(Err(RegisterError::PushOff));
        queue.push_back(Err(RegisterError::BadParams));
    }
    let given = params(json!({"handle": "h", "platform": "fcm"}));
    let call = || push_register("dev_1", &given, &push);
    assert_eq!(call(), RpcOutcome::Ok(json!({"ok": true})));
    assert_eq!(
        push.register_calls.lock()[0],
        ("dev_1".to_owned(), Some(json!("h")), Some(json!("fcm")))
    );
    assert_eq!(call(), refused(-32602, "push-off"));
    assert_eq!(call(), refused(-32602, "bad-params"));
}

#[test]
fn psh_c41_answers_push_unregister_ok() {
    let push = FakePush {
        unregister_result: json!({"ok": true}),
        ..FakePush::default()
    };
    assert_eq!(
        push_unregister("dev_1", &push),
        RpcOutcome::Ok(json!({"ok": true}))
    );
    assert_eq!(*push.unregister_calls.lock(), vec!["dev_1".to_owned()]);
}

#[test]
fn passes_a_missing_handle_and_platform_on_as_missing_and_a_wrong_type_as_it_came() {
    let push = FakePush::default();
    {
        let mut queue = push.registers.lock();
        queue.push_back(Err(RegisterError::BadParams));
        queue.push_back(Err(RegisterError::BadParams));
    }
    push_register("dev_1", &Map::new(), &push);
    push_register(
        "dev_2",
        &params(json!({"handle": 7, "platform": null})),
        &push,
    );
    let calls = push.register_calls.lock();
    assert_eq!(calls[0], ("dev_1".to_owned(), None, None));
    assert_eq!(
        calls[1],
        ("dev_2".to_owned(), Some(json!(7)), Some(Value::Null))
    );
}

#[test]
fn answers_push_unregister_with_whatever_the_push_service_returned() {
    let push = FakePush {
        unregister_result: json!({"ok": false, "removed": 0}),
        ..FakePush::default()
    };
    assert_eq!(
        push_unregister("dev_1", &push),
        RpcOutcome::Ok(json!({"ok": false, "removed": 0}))
    );
}
