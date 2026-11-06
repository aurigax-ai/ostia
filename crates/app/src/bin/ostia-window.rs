use ostia_app::logging::log_filter;
use ostia_app::shell::bridge::Bridge;
use ostia_app::shell::{Screen, ShellOptions, Terminals, run_window};
use ostia_base::host::Host;
use ostia_model::ids::IdNamespace;

fn value_of(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(log_filter())
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    run_window(ShellOptions {
        screen: Screen::parse(value_of(&args, "--screen").as_deref()),
        theme: value_of(&args, "--theme"),
        terminals: Terminals::DefaultShell,
        namespace: IdNamespace::default(),
        bridge: Bridge::for_host(&Host::current()),
    });
}
