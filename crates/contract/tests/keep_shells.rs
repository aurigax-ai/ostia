#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::keep_shells::{
    KEEP_SHELLS_FEATURE, KEPT_SHELLS_DIR, TMUX_MIN_VERSION, parse_keep_shells,
};
use serde_json::{Value, json};

#[test]
fn ksh_c3_reads_anything_but_true_as_off() {
    assert!(parse_keep_shells(&json!(true)));
    let others: [Value; 7] = [
        json!("yes"),
        json!("true"),
        json!(1),
        Value::Null,
        json!({}),
        json!(false),
        json!([true]),
    ];
    for raw in others {
        assert!(!parse_keep_shells(&raw), "raw {raw}");
    }
}

#[test]
fn keeps_the_feature_name_the_tmux_floor_and_the_folder_name() {
    assert_eq!(KEEP_SHELLS_FEATURE, "keep-shells");
    assert_eq!(TMUX_MIN_VERSION, "3.2");
    assert_eq!(KEPT_SHELLS_DIR, "kept-shells");
}
