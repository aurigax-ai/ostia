#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io;
use std::sync::{Arc, Mutex};

use ostia_app::logging::log_filter_over;
use tracing_subscriber::EnvFilter;

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl io::Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn captured(filter: EnvFilter) -> String {
    let buffer = Buffer::default();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer({
            let buffer = buffer.clone();
            move || buffer.clone()
        })
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        tracing::debug!(target: "rmcp::transport::auth", "auth-debug");
        tracing::info!(target: "rmcp::transport::auth", "auth-info");
        tracing::debug!(target: "rmcp::transport::streamable", "other-debug");
    });
    let bytes = buffer.0.lock().unwrap().clone();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn keeps_rmcp_auth_debug_out_of_the_log_even_when_the_user_asks_for_debug() {
    let text = captured(log_filter_over(EnvFilter::new("debug")));
    assert!(!text.contains("auth-debug"), "{text}");
    assert!(text.contains("auth-info"), "{text}");
    assert!(text.contains("other-debug"), "{text}");
}

#[test]
fn keeps_rmcp_auth_debug_out_of_the_log_when_the_user_names_the_rmcp_target() {
    let text = captured(log_filter_over(EnvFilter::new("rmcp=trace")));
    assert!(!text.contains("auth-debug"), "{text}");
    assert!(text.contains("other-debug"), "{text}");
}
