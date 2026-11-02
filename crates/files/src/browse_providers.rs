use std::fs::File;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use ostia_contract::file_browse::BrowseLimits;
use tokio_util::sync::CancellationToken;

use crate::archive_file::EntryRead;
use crate::archive_tree::RawEntry;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowseKind {
    pub ext_id: String,
    pub kind: String,
}

#[derive(Clone)]
pub struct BrowseTarget {
    pub ext_id: String,
    pub kind: String,
    pub file: Arc<File>,
    pub size: u64,
}

impl std::fmt::Debug for BrowseTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowseTarget")
            .field("ext_id", &self.ext_id)
            .field("kind", &self.kind)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderListing {
    Listed { entries: Vec<RawEntry>, cut: bool },
    Failed { error: String },
}

pub trait BrowseProviders: Send + Sync {
    fn kind_for(&self, name: &str) -> Option<BrowseKind>;

    fn browsable(&self) -> Arc<dyn Fn(&str) -> bool + Send + Sync>;

    fn list(
        &self,
        target: BrowseTarget,
        limits: BrowseLimits,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, ProviderListing>;

    fn read(
        &self,
        target: BrowseTarget,
        index: usize,
        max: u64,
        limits: BrowseLimits,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, EntryRead>;
}
