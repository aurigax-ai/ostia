use ostia_app::App;
use ostia_app::logging::log_filter;
use ostia_base::host::Host;
use tokio::signal::unix::{SignalKind, signal};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(log_filter())
        .with_writer(std::io::stderr)
        .init();
    let app = App::start(&Host::current())?;
    tracing::info!(socket = %app.socket.display(), "control socket ready");
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
    app.stop();
    Ok(())
}
