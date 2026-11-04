#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use ostia_base::clock::Clock;
use ostia_base::host::{Host, Platform};
use ostia_gateway::pairing::{
    PairAudit, PairCodes, PairOutcome, PairRateLimit, PairVia, format_code, pair_audit_log_path,
};
use serde_json::Value;
use tempfile::TempDir;

const ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

fn host_in(dir: &TempDir) -> Host {
    let env: BTreeMap<String, String> = [(
        "XDG_DATA_HOME".to_owned(),
        dir.path().to_string_lossy().into_owned(),
    )]
    .into_iter()
    .collect();
    Host {
        env,
        home: dir.path().join("home"),
        cwd: dir.path().to_path_buf(),
        platform: Platform::Linux,
    }
}

fn manual_clock() -> (Arc<AtomicI64>, Clock) {
    let now = Arc::new(AtomicI64::new(1_000_000));
    let reader = now.clone();
    (now, Arc::new(move || reader.load(Ordering::SeqCst)))
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn fixed(now: i64) -> Clock {
    Arc::new(move || now)
}

#[tokio::test]
async fn new_code_mints_an_8_char_code_from_the_qr_typo_resistant_alphabet() {
    let code = PairCodes::new().new_code();
    assert_eq!(code.len(), 8);
    assert!(code.chars().all(|c| ALPHABET.contains(c)), "{code}");
}

#[test]
fn cpd_c7_shows_a_code_as_two_groups_of_four_joined_by_a_dash() {
    assert_eq!(format_code("ABCDEFGH"), "ABCD-EFGH");
}

#[tokio::test]
async fn new_code_mints_distinct_codes_across_calls() {
    let codes = PairCodes::new();
    let minted: std::collections::HashSet<String> = (0..20).map(|_| codes.new_code()).collect();
    assert_eq!(minted.len(), 20);
}

#[tokio::test]
async fn new_code_draws_every_symbol_of_the_alphabet_with_equal_chance_at_every_position() {
    let codes = PairCodes::new();
    let draws = 4000;
    let mut counts: Vec<HashMap<char, u32>> = (0..8).map(|_| HashMap::new()).collect();
    for _ in 0..draws {
        for (position, symbol) in codes.new_code().chars().enumerate() {
            *counts[position].entry(symbol).or_insert(0) += 1;
        }
    }
    let expected = f64::from(draws) / ALPHABET.len() as f64;
    for (position, by_position) in counts.iter().enumerate() {
        let chi_squared: f64 = ALPHABET
            .chars()
            .map(|symbol| {
                let seen = f64::from(*by_position.get(&symbol).unwrap_or(&0));
                (seen - expected).powi(2) / expected
            })
            .sum();
        assert!(chi_squared < 90.0, "position {position}: {chi_squared}");
    }
}

#[tokio::test]
async fn consume_code_accepts_a_freshly_minted_unexpired_code() {
    let codes = PairCodes::new();
    let code = codes.new_code();
    assert!(codes.consume_code(&code));
}

#[tokio::test]
async fn consume_code_is_single_use_a_second_redemption_of_the_same_code_fails() {
    let codes = PairCodes::new();
    let code = codes.new_code();
    assert!(codes.consume_code(&code));
    assert!(!codes.consume_code(&code));
}

#[tokio::test]
async fn consume_code_rejects_an_unknown_code() {
    assert!(!PairCodes::new().consume_code("NOTREAL1"));
}

#[tokio::test]
async fn consume_code_rejects_a_code_past_its_120s_ttl() {
    let (now, clock) = manual_clock();
    let codes = PairCodes::with_clock(clock);
    let code = codes.new_code();
    now.fetch_add(120_001, Ordering::SeqCst);
    assert!(!codes.consume_code(&code));
}

#[tokio::test]
async fn consume_code_accepts_a_code_right_up_to_inclusive_of_its_ttl_boundary() {
    let (now, clock) = manual_clock();
    let codes = PairCodes::with_clock(clock);
    let code = codes.new_code();
    now.fetch_add(120_000, Ordering::SeqCst);
    assert!(codes.consume_code(&code));
}

#[tokio::test]
async fn reset_drops_every_pending_code() {
    let codes = PairCodes::new();
    let code = codes.new_code();
    codes.reset();
    assert!(!codes.consume_code(&code));
    assert_eq!(codes.live_code_count(), 0);
}

#[tokio::test]
async fn counts_live_codes_and_sweeps_the_expired_ones() {
    let (now, clock) = manual_clock();
    let codes = PairCodes::with_clock(clock);
    let first = codes.new_code();
    now.fetch_add(60_000, Ordering::SeqCst);
    let second = codes.new_code();
    assert_eq!(codes.live_code_count(), 2);
    assert!(codes.is_live_code(&first));
    now.fetch_add(60_001, Ordering::SeqCst);
    assert!(!codes.is_live_code(&first));
    assert!(codes.is_live_code(&second));
    assert_eq!(codes.live_code_count(), 1);
    now.fetch_add(60_000, Ordering::SeqCst);
    assert_eq!(codes.live_code_count(), 0);
}

#[tokio::test]
async fn is_live_code_does_not_use_up_the_code_and_is_inclusive_of_the_boundary() {
    let (now, clock) = manual_clock();
    let codes = PairCodes::with_clock(clock);
    let code = codes.new_code();
    assert!(codes.is_live_code(&code));
    assert!(codes.is_live_code(&code));
    now.fetch_add(120_000, Ordering::SeqCst);
    assert!(codes.is_live_code(&code));
    now.fetch_add(1, Ordering::SeqCst);
    assert!(!codes.is_live_code(&code));
    assert!(!codes.is_live_code("NOTREAL1"));
}

#[tokio::test]
async fn an_expired_code_that_is_redeemed_is_removed_and_refused() {
    let (now, clock) = manual_clock();
    let codes = PairCodes::with_clock(clock);
    let code = codes.new_code();
    now.fetch_add(120_001, Ordering::SeqCst);
    assert!(!codes.consume_code(&code));
    now.store(1_000_000, Ordering::SeqCst);
    assert!(!codes.consume_code(&code));
}

#[tokio::test]
async fn tells_a_subscriber_when_a_code_is_minted_or_used_but_not_when_nothing_changed() {
    let codes = PairCodes::new();
    let mut changed = codes.subscribe();
    let code = codes.new_code();
    assert!(changed.try_recv().is_ok());
    assert!(changed.try_recv().is_err());
    assert!(!codes.consume_code("NOTREAL1"));
    assert!(changed.try_recv().is_err());
    assert!(codes.consume_code(&code));
    assert!(changed.try_recv().is_ok());
    assert!(!codes.consume_code(&code));
    assert!(changed.try_recv().is_err());
}

#[tokio::test]
async fn tells_a_subscriber_when_an_expired_code_is_redeemed_and_not_when_codes_are_reset() {
    let (now, clock) = manual_clock();
    let codes = PairCodes::with_clock(clock);
    let code = codes.new_code();
    let mut changed = codes.subscribe();
    now.fetch_add(120_001, Ordering::SeqCst);
    assert!(!codes.consume_code(&code));
    assert!(changed.try_recv().is_ok());
    codes.new_code();
    assert!(changed.try_recv().is_ok());
    codes.reset();
    assert!(changed.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn tells_a_subscriber_one_millisecond_after_a_code_expires() {
    let started = tokio::time::Instant::now();
    let clock: Clock = Arc::new(move || i64::try_from(started.elapsed().as_millis()).unwrap());
    let codes = PairCodes::with_clock(clock);
    let mut changed = codes.subscribe();
    codes.new_code();
    assert!(changed.try_recv().is_ok());
    tokio::time::advance(Duration::from_millis(120_000)).await;
    tokio::task::yield_now().await;
    assert!(changed.try_recv().is_err());
    tokio::time::advance(Duration::from_millis(1)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(changed.try_recv().is_ok());
    assert!(changed.try_recv().is_err());
    assert_eq!(codes.live_code_count(), 0);
}

#[tokio::test(start_paused = true)]
async fn counts_the_expiry_timer_from_the_call_to_new_code() {
    let started = tokio::time::Instant::now();
    let clock: Clock = Arc::new(move || i64::try_from(started.elapsed().as_millis()).unwrap());
    let codes = PairCodes::with_clock(clock);
    let mut changed = codes.subscribe();
    codes.new_code();
    assert!(changed.try_recv().is_ok());
    tokio::time::advance(Duration::from_millis(120_001)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(changed.try_recv().is_ok());
}

#[test]
fn allows_up_to_5_attempts_per_ip_within_the_window() {
    let limit = PairRateLimit::new();
    for _ in 0..5 {
        assert!(limit.check("1.2.3.4"));
    }
}

#[test]
fn rejects_the_6th_attempt_from_the_same_ip_within_the_window() {
    let limit = PairRateLimit::new();
    for _ in 0..5 {
        limit.check("1.2.3.4");
    }
    assert!(!limit.check("1.2.3.4"));
}

#[test]
fn tracks_each_source_ip_independently() {
    let limit = PairRateLimit::new();
    for _ in 0..5 {
        limit.check("1.2.3.4");
    }
    assert!(!limit.check("1.2.3.4"));
    assert!(limit.check("5.6.7.8"));
}

#[test]
fn reset_drops_every_counter() {
    let limit = PairRateLimit::new();
    for _ in 0..5 {
        limit.check("1.2.3.4");
    }
    limit.reset();
    assert!(limit.check("1.2.3.4"));
}

#[test]
fn lets_an_attempt_through_once_the_oldest_leaves_the_60s_window() {
    let (now, clock) = manual_clock();
    let limit = PairRateLimit::with_clock(clock);
    for _ in 0..5 {
        assert!(limit.check("1.2.3.4"));
    }
    now.fetch_add(59_999, Ordering::SeqCst);
    assert!(!limit.check("1.2.3.4"));
    let (other_now, other_clock) = manual_clock();
    let other = PairRateLimit::with_clock(other_clock);
    for _ in 0..5 {
        assert!(other.check("1.2.3.4"));
    }
    other_now.fetch_add(60_000, Ordering::SeqCst);
    assert!(other.check("1.2.3.4"));
}

#[test]
fn counts_a_refused_attempt_toward_the_window_so_hammering_keeps_the_ip_locked_out() {
    let (now, clock) = manual_clock();
    let limit = PairRateLimit::with_clock(clock);
    for _ in 0..5 {
        assert!(limit.check("1.2.3.4"));
    }
    now.fetch_add(30_000, Ordering::SeqCst);
    for _ in 0..5 {
        assert!(!limit.check("1.2.3.4"));
    }
    now.fetch_add(30_000, Ordering::SeqCst);
    assert!(!limit.check("1.2.3.4"));
    now.fetch_add(60_000, Ordering::SeqCst);
    assert!(limit.check("1.2.3.4"));
}

#[test]
fn audit_pair_attempt_appends_a_newline_delimited_json_line_per_call() {
    let dir = TempDir::new().unwrap();
    let host = host_in(&dir);
    let audit = PairAudit::new(pair_audit_log_path(&host));
    audit.record("1.2.3.4", PairOutcome::Ok, None);
    audit.record("1.2.3.4", PairOutcome::InvalidCode, None);
    let text =
        fs::read_to_string(dir.path().join("ostia-rs").join("gateway-pair-audit.log")).unwrap();
    assert!(text.ends_with('\n'));
    let lines: Vec<&str> = text.trim().split('\n').collect();
    assert_eq!(lines.len(), 2);
    let first: Value = serde_json::from_str(lines[0]).unwrap();
    let second: Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(first["ip"], "1.2.3.4");
    assert_eq!(first["outcome"], "ok");
    assert_eq!(second["ip"], "1.2.3.4");
    assert_eq!(second["outcome"], "invalid-code");
}

#[test]
fn writes_the_same_audit_lines_as_the_ts_function() {
    let dir = TempDir::new().unwrap();
    let path = pair_audit_log_path(&host_in(&dir));
    let audit = PairAudit::with_clock(path.clone(), fixed(1_700_000_000_000));
    audit.record("127.0.0.1", PairOutcome::Ok, None);
    audit.record("::ffff:127.0.0.1", PairOutcome::InvalidCode, None);
    audit.record("::1", PairOutcome::BadRequest, None);
    audit.record("203.0.113.9", PairOutcome::RateLimited, None);
    audit.record("203.0.113.9", PairOutcome::Ok, Some(PairVia::Relay));
    audit.record("127.0.0.1", PairOutcome::Ok, Some(PairVia::Relay));
    audit.record("127.evil", PairOutcome::Ok, None);
    assert_eq!(
        fs::read(&path).unwrap(),
        fs::read(fixture("gateway-pair-audit.jsonl")).unwrap()
    );
}

#[test]
fn leaves_the_audit_trail_alone_and_fails_quietly_when_it_cannot_write() {
    let dir = TempDir::new().unwrap();
    let blocker = dir.path().join("ostia-rs");
    fs::write(&blocker, "a file where the folder should be").unwrap();
    let audit = PairAudit::new(pair_audit_log_path(&host_in(&dir)));
    audit.record("1.2.3.4", PairOutcome::Ok, None);
    assert_eq!(
        fs::read_to_string(&blocker).unwrap(),
        "a file where the folder should be"
    );
}

#[test]
fn keeps_the_audit_log_in_the_app_data_folder() {
    let dir = TempDir::new().unwrap();
    let host = host_in(&dir);
    assert_eq!(
        pair_audit_log_path(&host),
        host.app_data_dir().join("gateway-pair-audit.log")
    );
}
