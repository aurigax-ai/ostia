use ostia_base::js::non_empty;
use ostia_rpc::{Client, ClientError};
use serde_json::{Map, Value, json};

use super::args::{FlagError, FlagSpec, UnknownFlags, parse_args};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceRow {
    pub workspace_id: String,
    pub name: String,
    pub custom_name: Option<String>,
}

impl WorkspaceRow {
    fn from_json(value: &Value) -> Self {
        let text = |key: &str| value.get(key).and_then(Value::as_str);
        Self {
            workspace_id: text("workspaceId").unwrap_or_default().to_owned(),
            name: text("name").unwrap_or_default().to_owned(),
            custom_name: text("customName").map(str::to_owned),
        }
    }

    fn shown_name(&self) -> &str {
        non_empty(self.custom_name.as_deref()).unwrap_or(&self.name)
    }

    fn describe(&self) -> String {
        let shown = self.shown_name();
        if shown == self.name {
            format!("{} ({shown})", self.workspace_id)
        } else {
            format!("{} ({shown}, folder {})", self.workspace_id, self.name)
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PickError {
    #[error("workspace name '{reference}' matches {count} workspaces: {candidates}; pass the id")]
    Ambiguous {
        reference: String,
        count: usize,
        candidates: String,
    },
    #[error("no workspace '{reference}' (see: ostia workspace list)")]
    Unknown { reference: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error(transparent)]
    Request(#[from] ClientError),
    #[error(transparent)]
    Pick(#[from] PickError),
}

pub fn pick_workspace(rows: &[WorkspaceRow], reference: &str) -> Result<String, PickError> {
    if let Some(row) = rows.iter().find(|row| row.workspace_id == reference) {
        return Ok(row.workspace_id.clone());
    }
    let shown: Vec<&WorkspaceRow> = rows
        .iter()
        .filter(|row| row.shown_name() == reference)
        .collect();
    let named = if shown.is_empty() {
        rows.iter().filter(|row| row.name == reference).collect()
    } else {
        shown
    };
    match named.as_slice() {
        [only] => Ok(only.workspace_id.clone()),
        [] => Err(PickError::Unknown {
            reference: reference.to_owned(),
        }),
        many => Err(PickError::Ambiguous {
            reference: reference.to_owned(),
            count: many.len(),
            candidates: many
                .iter()
                .map(|row| row.describe())
                .collect::<Vec<_>>()
                .join(", "),
        }),
    }
}

pub async fn resolve_workspace_ref(
    client: &Client,
    reference: &str,
) -> Result<String, ResolveError> {
    let listed = client.request("workspace.list", None).await?;
    let rows: Vec<WorkspaceRow> = listed
        .as_array()
        .map(|items| items.iter().map(WorkspaceRow::from_json).collect())
        .unwrap_or_default();
    Ok(pick_workspace(&rows, reference)?)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandFlags {
    pub workspace: Option<String>,
    pub rest: Vec<String>,
}

const COMMAND_FLAGS: FlagSpec = FlagSpec {
    values: &[("workspace", "--workspace")],
    lists: &[],
    booleans: &[],
    unknown: UnknownFlags::Keep,
};

pub fn parse_command_flags(argv: &[&str]) -> Result<CommandFlags, FlagError> {
    let mut parsed = parse_args(argv, &COMMAND_FLAGS)?;
    let workspace = parsed.values.remove("workspace");
    if workspace.as_deref() == Some("") {
        return Err(FlagError {
            problem: super::args::FlagProblem::MissingValue,
            flag: "--workspace".to_owned(),
        });
    }
    Ok(CommandFlags {
        workspace,
        rest: parsed.positional,
    })
}

pub fn build_command_call(
    id: &str,
    flags: &CommandFlags,
    resolved_workspace: Option<&str>,
) -> Result<Value, serde_json::Error> {
    let mut call = Map::new();
    call.insert("id".to_owned(), Value::String(id.to_owned()));
    if let Some(raw) = non_empty(flags.rest.first().map(String::as_str)) {
        call.insert("args".to_owned(), serde_json::from_str(raw)?);
    }
    if let Some(workspace_id) = non_empty(resolved_workspace) {
        call.insert(
            "target".to_owned(),
            json!({"workspaceId": workspace_id, "paneId": null}),
        );
    }
    Ok(Value::Object(call))
}
