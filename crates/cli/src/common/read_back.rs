use std::future::Future;
use std::time::Duration;

use ostia_rpc::{Client, ClientError};
use serde_json::Value;
use tokio::time::{Instant, MissedTickBehavior, interval_at, timeout};

const READ_BACK: Duration = Duration::from_millis(3000);
const READ_BACK_POLL: Duration = Duration::from_millis(100);

pub type Settled<T> = Result<T, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedFile {
    pub path: String,
    pub pane_id: String,
}

async fn read_back<T, F, Fut>(mut observe: F) -> Result<Settled<T>, ClientError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Settled<T>, ClientError>>,
{
    let mut missing = match observe().await? {
        Ok(found) => return Ok(Ok(found)),
        Err(missing) => missing,
    };
    let polled = timeout(READ_BACK, async {
        let mut ticker = interval_at(Instant::now() + READ_BACK_POLL, READ_BACK_POLL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match observe().await? {
                Ok(found) => return Ok::<T, ClientError>(found),
                Err(still_missing) => missing = still_missing,
            }
        }
    })
    .await;
    match polled {
        Ok(found) => found.map(Ok),
        Err(_) => Ok(Err(missing)),
    }
}

async fn list(conn: &Client, method: &str) -> Result<Vec<Value>, ClientError> {
    match conn.request(method, None).await? {
        Value::Array(rows) => Ok(rows),
        _ => Ok(Vec::new()),
    }
}

fn text_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

pub async fn confirm_files_open(
    conn: &Client,
    paths: &[&str],
) -> Result<Settled<Vec<OpenedFile>>, ClientError> {
    read_back(|| async move {
        let panes = list(conn, "pane.list").await?;
        let mut opened = Vec::with_capacity(paths.len());
        for path in paths {
            let Some(pane) = panes
                .iter()
                .find(|pane| text_of(pane, "filePath") == Some(*path))
            else {
                return Ok(Err(format!(
                    "ostia open: {path} has no tab after opening it"
                )));
            };
            opened.push(OpenedFile {
                path: (*path).to_owned(),
                pane_id: text_of(pane, "paneId").unwrap_or_default().to_owned(),
            });
        }
        Ok(Ok(opened))
    })
    .await
}

pub async fn confirm_pane_open(
    conn: &Client,
    pane_id: &str,
    what: &str,
) -> Result<Settled<String>, ClientError> {
    read_back(|| async move {
        let panes = list(conn, "pane.list").await?;
        Ok(
            if panes
                .iter()
                .any(|pane| text_of(pane, "paneId") == Some(pane_id))
            {
                Ok(pane_id.to_owned())
            } else {
                Err(format!("ostia open: {what} has no pane after opening it"))
            },
        )
    })
    .await
}

pub async fn confirm_workspace(
    conn: &Client,
    workspace_id: &str,
) -> Result<Settled<String>, ClientError> {
    read_back(|| async move {
        let rows = list(conn, "workspace.list").await?;
        Ok(
            if rows
                .iter()
                .any(|row| text_of(row, "workspaceId") == Some(workspace_id))
            {
                Ok(workspace_id.to_owned())
            } else {
                Err(format!(
                    "ostia workspace new: workspace {workspace_id} is not in the workspace list"
                ))
            },
        )
    })
    .await
}
