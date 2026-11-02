use std::process::ExitCode;

use ostia_base::host::Host;
use ostia_base::process::parent_pid;
use ostia_cli::common::failure::describe_failure;
use ostia_cli::common::pane_token::pane_token;
use ostia_cli::verbs::introspection::run_whoami;
use ostia_control::discovery::{control_info_path, pane_control_socket};
use ostia_rpc::{Client, ClientError};
use serde_json::json;

const SCRIPT_TOKEN_PREFIX: &str = "ostia_";

fn report(label: &str, error: &ClientError) {
    match error {
        ClientError::Closed => eprintln!("ostia: connection to the app closed (did Ostia quit?)"),
        ClientError::Rpc(error) => eprintln!("{label}: {}", describe_failure(error)),
    }
}

async fn run(host: &Host, verb: &str) -> ExitCode {
    let token = pane_token(host);
    let script = token
        .as_deref()
        .is_some_and(|token| token.starts_with(SCRIPT_TOKEN_PREFIX));
    let Some(socket) =
        pane_control_socket(host.app_var("SOCKET"), script, &control_info_path(host))
    else {
        eprintln!("ostia: app not reachable");
        return ExitCode::FAILURE;
    };
    let Ok(client) = Client::connect(&socket).await else {
        eprintln!("ostia: app not reachable at {}", socket.display());
        return ExitCode::FAILURE;
    };
    let hello = json!({"token": token, "pid": parent_pid()});
    if let Err(error) = client.request("hello", Some(&hello)).await {
        report(&format!("ostia {verb}"), &error);
        return ExitCode::FAILURE;
    }
    match run_whoami(&client).await {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            report(&format!("ostia {verb}"), &error);
            ExitCode::FAILURE
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let verb = std::env::args().nth(1).unwrap_or_default();
    if verb != "whoami" {
        eprintln!("ostia: {verb} is not ported yet");
        return ExitCode::FAILURE;
    }
    run(&Host::current(), &verb).await
}
