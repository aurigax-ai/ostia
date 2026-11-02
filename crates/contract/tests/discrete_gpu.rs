#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::discrete_gpu::{parse_discrete_gpu, renderer_device_name};
use serde_json::{Value, json};

#[test]
fn takes_the_device_out_of_angles_renderer_string() {
    assert_eq!(
        renderer_device_name(
            "ANGLE (Intel, Mesa Intel(R) Arc(tm) A370M Graphics (DG2), OpenGL ES 3.2)"
        ),
        "Mesa Intel(R) Arc(tm) A370M Graphics (DG2)"
    );
}

#[test]
fn keeps_any_other_renderer_string_as_it_is() {
    assert_eq!(renderer_device_name("llvmpipe"), "llvmpipe");
}

#[test]
fn is_on_only_for_true() {
    assert!(parse_discrete_gpu(&json!(true)));
    assert!(!parse_discrete_gpu(&json!("true")));
    assert!(!parse_discrete_gpu(&Value::Null));
}
