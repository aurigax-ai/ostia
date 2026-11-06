use tracing_subscriber::EnvFilter;
use tracing_subscriber::filter::Directive;

const RMCP_AUTH_DIRECTIVE: &str = "rmcp::transport::auth=info";

pub fn log_filter() -> EnvFilter {
    log_filter_over(EnvFilter::from_default_env())
}

pub fn log_filter_over(filter: EnvFilter) -> EnvFilter {
    match RMCP_AUTH_DIRECTIVE.parse::<Directive>() {
        Ok(directive) => filter.add_directive(directive),
        Err(_) => filter,
    }
}
