#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_issues::{
    BudgetBreach, MAIL_INBOX_FULL, MAIL_LEASE_TIMEOUT, MAIL_PANE_CLOSED, MAIL_REFUSED, OVER_BUDGET,
    READBACK_CODES, READBACK_MISMATCH, STALE_MAIL_MS, WAKE_BUDGET_MS, WAKE_NOT_READY,
    budget_breach, mail_expired, verb_budget, verb_code,
};

#[test]
fn takes_the_code_before_the_colon_of_the_existing_answer_prefix() {
    assert_eq!(verb_code("unknown-pane: 3f2a…"), "unknown-pane");
    assert_eq!(
        verb_code("not-submitted: the pane shows the text"),
        "not-submitted"
    );
    assert_eq!(verb_code("sandboxed"), "sandboxed");
}

#[test]
fn never_lets_free_text_digits_capitals_or_a_secret_through_as_a_code() {
    let long = "a".repeat(60);
    for message in [
        "denied the thing because",
        "sk-live-1234567890",
        "Error: boom",
        "",
        long.as_str(),
        "unknown identity",
    ] {
        assert_eq!(verb_code(message), "error", "{message}");
    }
}

#[test]
fn builds_the_expiry_reason_from_the_last_pending_reason() {
    assert_eq!(mail_expired("hibernated"), "expired:hibernated");
}

#[test]
fn knows_the_read_back_mismatch_codes_of_the_verbs() {
    for code in [
        "not-submitted",
        "not-queued",
        "not-started",
        "not-recorded",
        "still-open",
    ] {
        assert!(READBACK_CODES.contains(&code), "{code}");
    }
    assert!(!READBACK_CODES.contains(&"unknown-pane"));
}

#[test]
fn names_the_budget_that_was_passed_time_before_size_and_nothing_for_a_verb_without_a_budget() {
    let read = verb_budget("pane.read").unwrap();
    let ms = read.ms.unwrap_or(0);
    let bytes = read.bytes.unwrap_or(0);
    assert_eq!(
        budget_breach("pane.read", ms + 1, 1),
        Some(BudgetBreach::Ms)
    );
    assert_eq!(
        budget_breach("pane.read", 1, bytes + 1),
        Some(BudgetBreach::Bytes)
    );
    assert_eq!(budget_breach("pane.read", ms, bytes), None);
    assert_eq!(budget_breach("whoami", 99_999, 99_999_999), None);
}

#[test]
fn keeps_the_constant_codes_and_budgets_of_the_ts_module() {
    assert_eq!(MAIL_PANE_CLOSED, "pane-closed");
    assert_eq!(MAIL_REFUSED, "agent-refused");
    assert_eq!(MAIL_INBOX_FULL, "inbox-full");
    assert_eq!(MAIL_LEASE_TIMEOUT, "lease-timeout");
    assert_eq!(WAKE_NOT_READY, "wake-not-ready");
    assert_eq!(READBACK_MISMATCH, "readback-mismatch");
    assert_eq!(OVER_BUDGET, "over-budget");
    assert_eq!(WAKE_BUDGET_MS, 120_000);
    assert_eq!(STALE_MAIL_MS, 600_000);
    assert_eq!(READBACK_CODES.len(), 5);
}

#[test]
fn keeps_the_time_and_size_budget_of_every_verb() {
    let table: [(&str, Option<u64>, Option<u64>); 9] = [
        ("pane.list", None, Some(24_000)),
        ("pane.read", Some(3000), Some(16_000)),
        ("pane.status", Some(3000), Some(6000)),
        ("pane.transcript", Some(3000), Some(32_000)),
        ("pane.input", Some(8000), None),
        ("pane.wait", None, Some(2000)),
        ("bus.send", Some(3000), Some(2000)),
        ("bus.inbox", None, Some(12_000)),
        ("bus.sent", None, Some(12_000)),
    ];
    for (method, ms, bytes) in table {
        let budget = verb_budget(method).unwrap();
        assert_eq!(budget.ms, ms, "{method}");
        assert_eq!(budget.bytes, bytes, "{method}");
    }
    assert!(verb_budget("whoami").is_none());
}

#[test]
fn ignores_a_missing_limit_and_names_a_breach_only_above_the_limit() {
    assert_eq!(budget_breach("pane.list", 999_999, 24_000), None);
    assert_eq!(
        budget_breach("pane.list", 0, 24_001),
        Some(BudgetBreach::Bytes)
    );
    assert_eq!(budget_breach("pane.input", 8000, 999_999), None);
    assert_eq!(budget_breach("pane.input", 8001, 0), Some(BudgetBreach::Ms));
    assert_eq!(
        budget_breach("pane.read", 3001, 16_001),
        Some(BudgetBreach::Ms)
    );
}

#[test]
fn limits_a_code_to_forty_one_letters_and_dashes_and_needs_the_end_or_a_colon_after_it() {
    let max = format!("a{}", "b".repeat(40));
    let over = format!("a{}", "b".repeat(41));
    assert_eq!(verb_code(&max), max);
    assert_eq!(verb_code(&format!("{max}: text")), max);
    assert_eq!(verb_code(&over), "error");
    assert_eq!(verb_code("abc\n"), "error");
    assert_eq!(verb_code("-abc"), "error");
    assert_eq!(verb_code("a-b-c"), "a-b-c");
    assert_eq!(verb_code("a_b"), "error");
    assert_eq!(verb_code(":abc"), "error");
}
