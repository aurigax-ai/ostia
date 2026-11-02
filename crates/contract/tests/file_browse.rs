#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::file_browse::{
    BROWSE_CACHE_BLOCKS, BROWSE_CHUNK_METHOD, BROWSE_ENTRIES_METHOD, BROWSE_LIMITS,
    BROWSE_LIST_METHOD, BROWSE_LISTING_BYTES, BROWSE_NAME_BYTES, BROWSE_PAGE_BYTES,
    BROWSE_PAGE_ENTRIES, BROWSE_READ_AT_METHOD, BROWSE_READ_MAX, BROWSE_READ_METHOD,
    BrowseCallError, BrowseEntry, BrowseListError, BrowseListParams, BrowseReadAtParams,
    BrowseReadError, browse_blocks, browse_call_budget, browse_read_budget,
};
use serde_json::json;

#[test]
fn keeps_the_browse_sizes_and_method_names_of_the_extension_contract() {
    assert_eq!(BROWSE_READ_MAX, 1_048_576);
    assert_eq!(BROWSE_PAGE_ENTRIES, 500);
    assert_eq!(BROWSE_PAGE_BYTES, 262_144);
    assert_eq!(BROWSE_CACHE_BLOCKS, 8);
    assert_eq!(BROWSE_NAME_BYTES, 4_096);
    assert_eq!(BROWSE_LISTING_BYTES, 8_388_608);
    assert_eq!(BROWSE_LIST_METHOD, "ext.browse.list");
    assert_eq!(BROWSE_READ_METHOD, "ext.browse.read");
    assert_eq!(BROWSE_READ_AT_METHOD, "ext.browse.readAt");
    assert_eq!(BROWSE_ENTRIES_METHOD, "ext.browse.entries");
    assert_eq!(BROWSE_CHUNK_METHOD, "ext.browse.chunk");
}

#[test]
fn keeps_the_scan_limits_and_writes_them_in_camel_case() {
    assert_eq!(
        serde_json::to_value(BROWSE_LIMITS).unwrap(),
        json!({
            "entries": 20000,
            "depth": 32,
            "nameLength": 1024,
            "scanBytes": 1_073_741_824u64,
            "scanMs": 20000,
            "linkTargetBytes": 1024,
        })
    );
}

#[test]
fn counts_the_read_blocks_of_a_size_rounding_up() {
    let cases = [
        (0, 0),
        (1, 1),
        (BROWSE_READ_MAX - 1, 1),
        (BROWSE_READ_MAX, 1),
        (BROWSE_READ_MAX + 1, 2),
        (3 * BROWSE_READ_MAX, 3),
        (3 * BROWSE_READ_MAX + 1, 4),
    ];
    for (size, blocks) in cases {
        assert_eq!(browse_blocks(size), blocks, "size {size}");
    }
}

#[test]
fn allows_twice_the_size_plus_one_block_for_reads() {
    assert_eq!(browse_read_budget(0), BROWSE_READ_MAX);
    assert_eq!(browse_read_budget(10), 20 + BROWSE_READ_MAX);
    assert_eq!(browse_read_budget(BROWSE_READ_MAX), 3 * BROWSE_READ_MAX);
}

#[test]
fn allows_twice_the_blocks_plus_64_calls() {
    assert_eq!(browse_call_budget(0), 64);
    assert_eq!(browse_call_budget(1), 66);
    assert_eq!(browse_call_budget(BROWSE_READ_MAX + 1), 68);
}

#[test]
fn writes_an_entry_with_a_null_link_and_reads_it_back() {
    let entry = BrowseEntry {
        name: "a.txt".to_owned(),
        dir: false,
        size: 5,
        encrypted: false,
        link: None,
    };
    let value = serde_json::to_value(&entry).unwrap();
    assert_eq!(
        value,
        json!({"name": "a.txt", "dir": false, "size": 5, "encrypted": false, "link": null})
    );
    assert_eq!(serde_json::from_value::<BrowseEntry>(value).unwrap(), entry);
}

#[test]
fn writes_the_error_names_in_kebab_case() {
    let list = [
        (BrowseListError::Unsupported, "unsupported"),
        (BrowseListError::Corrupt, "corrupt"),
        (BrowseListError::Limit, "limit"),
        (BrowseListError::Cancelled, "cancelled"),
        (BrowseListError::Failed, "failed"),
        (BrowseListError::Encrypted, "encrypted"),
    ];
    for (error, name) in list {
        assert_eq!(serde_json::to_value(error).unwrap(), json!(name));
    }
    let read = [
        (BrowseReadError::Gone, "gone"),
        (BrowseReadError::Encrypted, "encrypted"),
        (BrowseReadError::Link, "link"),
        (BrowseReadError::TooLarge, "too-large"),
        (BrowseReadError::Limit, "limit"),
        (BrowseReadError::Corrupt, "corrupt"),
        (BrowseReadError::Cancelled, "cancelled"),
        (BrowseReadError::Failed, "failed"),
    ];
    for (error, name) in read {
        assert_eq!(serde_json::to_value(error).unwrap(), json!(name));
    }
    let call = [
        (BrowseCallError::UnknownTicket, "unknown-ticket"),
        (BrowseCallError::OverBudget, "over-budget"),
        (BrowseCallError::OutOfRange, "out-of-range"),
        (BrowseCallError::Unaligned, "unaligned"),
        (BrowseCallError::Invalid, "invalid"),
    ];
    for (error, name) in call {
        assert_eq!(serde_json::to_value(error).unwrap(), json!(name));
    }
}

#[test]
fn reads_the_call_params_in_camel_case() {
    let list: BrowseListParams = serde_json::from_value(json!({
        "ticket": "t1",
        "kind": "zip",
        "size": 9,
        "limits": serde_json::to_value(BROWSE_LIMITS).unwrap(),
    }))
    .unwrap();
    assert_eq!(list.ticket, "t1");
    assert_eq!(list.limits, BROWSE_LIMITS);
    let at: BrowseReadAtParams =
        serde_json::from_value(json!({"ticket": "t1", "offset": 4, "length": 8})).unwrap();
    assert_eq!((at.offset, at.length), (4, 8));
}
