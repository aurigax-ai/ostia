use std::future::Future;

use serde_json::{Map, Value, json};

use crate::rpc_outcome::RpcOutcome;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketError {
    PushOff,
    RateLimited,
    ServerUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegisterError {
    PushOff,
    BadParams,
}

pub trait PhonePushPort {
    fn ticket(
        &self,
        device_id: &str,
    ) -> impl Future<Output = Result<(String, i64), TicketError>> + Send;

    fn register(
        &self,
        device_id: &str,
        handle: Option<&Value>,
        platform: Option<&Value>,
    ) -> Result<(), RegisterError>;

    fn unregister(&self, device_id: &str) -> Value;
}

fn push_off() -> RpcOutcome {
    RpcOutcome::refused(-32602, "push-off")
}

pub async fn push_ticket(device_id: &str, push: &impl PhonePushPort) -> RpcOutcome {
    match push.ticket(device_id).await {
        Ok((ticket, expires_at)) => {
            RpcOutcome::Ok(json!({"ticket": ticket, "expiresAt": expires_at}))
        }
        Err(TicketError::PushOff) => push_off(),
        Err(TicketError::RateLimited) => RpcOutcome::refused(-32007, "rate-limited"),
        Err(TicketError::ServerUnavailable) => RpcOutcome::refused(-32603, "server-unavailable"),
    }
}

pub fn push_register(
    device_id: &str,
    params: &Map<String, Value>,
    push: &impl PhonePushPort,
) -> RpcOutcome {
    match push.register(device_id, params.get("handle"), params.get("platform")) {
        Ok(()) => RpcOutcome::Ok(json!({"ok": true})),
        Err(RegisterError::PushOff) => push_off(),
        Err(RegisterError::BadParams) => RpcOutcome::refused(-32602, "bad-params"),
    }
}

pub fn push_unregister(device_id: &str, push: &impl PhonePushPort) -> RpcOutcome {
    RpcOutcome::Ok(push.unregister(device_id))
}
