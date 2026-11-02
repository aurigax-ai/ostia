use ostia_app::shell::{Screen, ShellOptions, run_window};
use tracing_subscriber::EnvFilter;

fn value_of(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    run_window(ShellOptions {
        screen: Screen::parse(value_of(&args, "--screen").as_deref()),
        theme: value_of(&args, "--theme"),
        shell_argv: Vec::new(),
    });
}
