use std::future::Future;

use ostia_contract::remote_folders::{
    REMOTE_WRITE_ANY, REMOTE_WRITE_NEW, RemoteFileError, RemoteReadResult, RemoteStatResult,
    RemoteWriteResult,
};

pub const REMOTE_POLL_MS: u64 = 3000;

const NOT_FOUND: &str = "not-found";
const CHANGED: &str = "changed";

pub trait RemoteTextApi {
    fn stat(&self, path: &str) -> impl Future<Output = RemoteStatResult>;
    fn read(&self, path: &str) -> impl Future<Output = RemoteReadResult>;
    fn write(
        &self,
        path: &str,
        content: &str,
        base_version: &str,
    ) -> impl Future<Output = RemoteWriteResult>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteSaveOutcome {
    Saved { version: String },
    Conflict { disk: String, version: String },
    Deleted,
    Failed { error: RemoteFileError },
}

pub async fn save_remote_text(
    api: &impl RemoteTextApi,
    path: &str,
    text: &str,
    base: Option<&str>,
    force: bool,
) -> RemoteSaveOutcome {
    let base_version = if force {
        REMOTE_WRITE_ANY
    } else {
        base.unwrap_or(REMOTE_WRITE_NEW)
    };
    match api.write(path, text, base_version).await {
        RemoteWriteResult::Written(written) => RemoteSaveOutcome::Saved {
            version: written.version,
        },
        RemoteWriteResult::Failure(failure) if failure.error.as_str() != CHANGED => {
            RemoteSaveOutcome::Failed {
                error: failure.error,
            }
        }
        RemoteWriteResult::Failure(_) => match api.read(path).await {
            RemoteReadResult::Content(now) => RemoteSaveOutcome::Conflict {
                disk: now.content,
                version: now.version,
            },
            RemoteReadResult::Failure(failure) if failure.error.as_str() == NOT_FOUND => {
                RemoteSaveOutcome::Deleted
            }
            RemoteReadResult::Failure(failure) => RemoteSaveOutcome::Failed {
                error: failure.error,
            },
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteCheckOutcome {
    Same,
    Changed { disk: String, version: String },
    Deleted,
    Unknown,
}

fn gone(known: Option<&str>) -> RemoteCheckOutcome {
    if known.is_none() {
        RemoteCheckOutcome::Same
    } else {
        RemoteCheckOutcome::Deleted
    }
}

pub async fn check_remote_text(
    api: &impl RemoteTextApi,
    path: &str,
    known: Option<&str>,
) -> RemoteCheckOutcome {
    match api.stat(path).await {
        RemoteStatResult::Failure(failure) => {
            return if failure.error.as_str() == NOT_FOUND {
                gone(known)
            } else {
                RemoteCheckOutcome::Unknown
            };
        }
        RemoteStatResult::Stat(stat) => {
            let Some(version) = stat.version.as_deref().filter(|_| stat.kind == "file") else {
                return RemoteCheckOutcome::Unknown;
            };
            if Some(version) == known {
                return RemoteCheckOutcome::Same;
            }
        }
    }
    match api.read(path).await {
        RemoteReadResult::Failure(failure) => {
            if failure.error.as_str() == NOT_FOUND {
                gone(known)
            } else {
                RemoteCheckOutcome::Unknown
            }
        }
        RemoteReadResult::Content(now) => {
            if Some(now.version.as_str()) == known {
                RemoteCheckOutcome::Same
            } else {
                RemoteCheckOutcome::Changed {
                    disk: now.content,
                    version: now.version,
                }
            }
        }
    }
}
