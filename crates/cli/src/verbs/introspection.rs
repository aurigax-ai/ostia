use ostia_rpc::{Client, ClientError};
use serde_json::{Value, json};

pub async fn run_whoami(client: &Client) -> Result<String, ClientError> {
    let mut who = client.request("whoami", None).await?;
    let has_pane = who
        .get("paneId")
        .is_some_and(|pane| pane.as_str().is_some_and(|pane| !pane.is_empty()));
    if has_pane {
        let state = client.request("pane.info", None).await?;
        if !state.is_null()
            && let Value::Object(record) = &mut who
        {
            record.insert(
                "cwd".to_owned(),
                state.get("cwd").cloned().unwrap_or(Value::Null),
            );
            record.insert(
                "running".to_owned(),
                json!(state.get("running") == Some(&json!(true))),
            );
        }
    }
    Ok(who.to_string())
}
