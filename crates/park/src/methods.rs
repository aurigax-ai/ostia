use std::sync::Arc;

use ostia_base::WorkspaceId;
use ostia_contract::agent_resume::ResumableAgent;
use ostia_contract::capabilities::Capability;
use ostia_control::{Callers, ControlMethod, DuplicateMethod, MethodContext, MethodTable};
use ostia_rpc::RpcError;
use serde_json::{Map, Value, json};

use crate::store::{ParkedRecord, ParkedStore};

pub type FromActivity = Arc<dyn Fn(&MethodContext) -> bool + Send + Sync>;

fn not_activity() -> Value {
    json!({"ok": false, "error": "activity-only"})
}

fn invalid_params() -> Value {
    json!({"ok": false, "error": "invalid-params"})
}

pub fn parked_item_of(record: &ParkedRecord) -> Option<Value> {
    if record.resume.agent == ResumableAgent::Agy {
        return None;
    }
    let mut item = Map::new();
    item.insert("id".to_owned(), json!(record.id));
    item.insert("workspaceId".to_owned(), json!(record.workspace_id));
    item.insert("agent".to_owned(), json!(record.resume.agent));
    item.insert("sessionId".to_owned(), json!(record.resume.id));
    item.insert("title".to_owned(), json!(record.title));
    if let Some(summary) = &record.summary {
        item.insert("summary".to_owned(), json!(summary));
    }
    if let Some(folder) = &record.resume.cwd {
        item.insert("folder".to_owned(), json!(folder));
    }
    item.insert("parkedAt".to_owned(), json!(record.parked_at));
    Some(Value::Object(item))
}

pub fn register_park_methods(
    table: &mut MethodTable,
    store: &ParkedStore,
    from_activity: &FromActivity,
) -> Result<(), DuplicateMethod> {
    let list_store = store.clone();
    let list_activity = Arc::clone(from_activity);
    table.register(
        "ext.parkedList",
        ControlMethod::new(move |params, ctx| {
            let store = list_store.clone();
            let from_activity = Arc::clone(&list_activity);
            async move {
                if !from_activity(&ctx) {
                    return Ok(not_activity());
                }
                let Some(workspace_id) = params.get("workspaceId").and_then(Value::as_str) else {
                    return Ok(invalid_params());
                };
                let items: Vec<Value> = store
                    .list(&WorkspaceId::new(workspace_id))
                    .iter()
                    .filter_map(parked_item_of)
                    .collect();
                Ok(json!({"ok": true, "items": items}))
            }
        })
        .callers(Callers::Extensions)
        .cap(Capability::ReadBoard),
    )?;
    let forget_store = store.clone();
    let forget_activity = Arc::clone(from_activity);
    table.register(
        "ext.parkedForget",
        ControlMethod::new(move |params, ctx| {
            let store = forget_store.clone();
            let from_activity = Arc::clone(&forget_activity);
            async move {
                if !from_activity(&ctx) {
                    return Ok(not_activity());
                }
                let Some(id) = params.get("id").and_then(Value::as_str) else {
                    return Ok(invalid_params());
                };
                match store.remove(id) {
                    Ok(true) => Ok(json!({"ok": true})),
                    Ok(false) => Ok(json!({"ok": false, "error": "unknown-parked"})),
                    Err(error) => Err(RpcError::from(error)),
                }
            }
        })
        .callers(Callers::Extensions)
        .cap(Capability::ReadBoard),
    )
}
