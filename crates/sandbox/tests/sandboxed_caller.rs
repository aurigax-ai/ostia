#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_sandbox::sandboxed_caller::SANDBOXED_REFUSAL;

#[test]
fn refuses_with_the_text_that_clients_read() {
    assert_eq!(
        SANDBOXED_REFUSAL,
        "sandboxed: a sandboxed workspace reaches only the sandboxed terminals of its own workspace"
    );
}
