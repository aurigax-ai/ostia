use std::io::Write;

use ostia_app::App;
use ostia_base::host::Host;
use ostia_contract::capabilities::Capability;
use ostia_contract::terminal_state::TerminalStateSnapshot;
use ostia_control::CapabilityStore;
use ostia_testkit::pane_input;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

fn parse_cap(name: &str) -> Result<Capability, serde_json::Error> {
    serde_json::from_value(json!(name))
}

fn seed(app: &App, spec: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let parts: Vec<&str> = spec.split(':').collect();
    let [window, workspace, pane, rest @ ..] = parts.as_slice() else {
        return Err(format!("--pane takes window:workspace:pane[:cap,cap], got {spec}").into());
    };
    let identity = app
        .registry
        .register_pane(pane_input(window, workspace, pane));
    app.grants.init_caps(&identity.external_id);
    for name in rest.iter().flat_map(|caps| caps.split(',')) {
        app.grants.grant(&identity.external_id, parse_cap(name)?);
    }
    app.terminal_states.push(TerminalStateSnapshot {
        pane_id: identity.pane_id.clone(),
        generation: 1,
        cwd: Some("/".to_owned()),
        running: false,
        block_count: 0,
        last_exit_code: None,
        remote: None,
    });
    Ok(
        json!({"paneId": identity.pane_id, "externalId": identity.external_id, "token": identity.token}),
    )
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let app = App::start(&Host::current())?;
    let mut panes = Vec::new();
    let mut extensions = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--pane" => panes.push(seed(&app, &value)?),
            "--extension" => {
                let identity = app.registry.register_extension(&value);
                extensions.push(json!({"extId": value, "externalId": identity.external_id, "token": identity.token}));
            }
            other => return Err(format!("unknown flag {other}").into()),
        }
    }
    let ready =
        json!({"socket": app.socket.to_string_lossy(), "panes": panes, "extensions": extensions});
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{ready}")?;
    stdout.flush()?;
    let mut sink = [0u8; 64];
    let mut stdin = tokio::io::stdin();
    while stdin.read(&mut sink).await? > 0 {}
    app.stop();
    Ok(())
}
