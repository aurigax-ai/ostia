use serde::{Deserialize, Serialize};

pub const BROWSE_READ_MAX: u64 = 1024 * 1024;
pub const BROWSE_PAGE_ENTRIES: usize = 500;
pub const BROWSE_PAGE_BYTES: usize = 256 * 1024;
pub const BROWSE_CACHE_BLOCKS: usize = 8;
pub const BROWSE_NAME_BYTES: usize = 4 * 1024;
pub const BROWSE_LISTING_BYTES: usize = 8 * 1024 * 1024;

pub const BROWSE_LIST_METHOD: &str = "ext.browse.list";
pub const BROWSE_READ_METHOD: &str = "ext.browse.read";
pub const BROWSE_READ_AT_METHOD: &str = "ext.browse.readAt";
pub const BROWSE_ENTRIES_METHOD: &str = "ext.browse.entries";
pub const BROWSE_CHUNK_METHOD: &str = "ext.browse.chunk";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseLimits {
    pub entries: usize,
    pub depth: usize,
    pub name_length: usize,
    pub scan_bytes: u64,
    pub scan_ms: u64,
    pub link_target_bytes: usize,
}

pub const BROWSE_LIMITS: BrowseLimits = BrowseLimits {
    entries: 20_000,
    depth: 32,
    name_length: 1_024,
    scan_bytes: 1024 * 1024 * 1024,
    scan_ms: 20_000,
    link_target_bytes: 1_024,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseEntry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub encrypted: bool,
    pub link: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowseListError {
    Unsupported,
    Corrupt,
    Limit,
    Cancelled,
    Failed,
    Encrypted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowseReadError {
    Gone,
    Encrypted,
    Link,
    TooLarge,
    Limit,
    Corrupt,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowseCallError {
    UnknownTicket,
    OverBudget,
    OutOfRange,
    Unaligned,
    Invalid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseListParams {
    pub ticket: String,
    pub kind: String,
    pub size: u64,
    pub limits: BrowseLimits,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseReadParams {
    pub ticket: String,
    pub kind: String,
    pub size: u64,
    pub limits: BrowseLimits,
    pub index: usize,
    pub max: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseReadAtParams {
    pub ticket: String,
    pub offset: u64,
    pub length: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntriesParams {
    pub ticket: String,
    pub entries: Vec<BrowseEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseChunkParams {
    pub ticket: String,
    pub data: String,
}

pub fn browse_blocks(size: u64) -> u64 {
    size.div_ceil(BROWSE_READ_MAX)
}

pub fn browse_read_budget(size: u64) -> u64 {
    2 * size + BROWSE_READ_MAX
}

pub fn browse_call_budget(size: u64) -> u64 {
    2 * browse_blocks(size) + 64
}
