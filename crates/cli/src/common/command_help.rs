use ostia_contract::commands::CommandDescriptor;

pub fn wants_help(arg: Option<&str>) -> bool {
    matches!(arg, Some("--help" | "-h"))
}

pub fn command_help(descriptor: &CommandDescriptor) -> String {
    let mut lines = vec![
        format!("{}: {}", descriptor.id, descriptor.title),
        String::new(),
        format!("usage: ostia {} [json-args]", descriptor.id),
        String::new(),
    ];
    match &descriptor.args_schema {
        Some(schema) => {
            lines.push("args (JSON):".to_owned());
            lines.push(schema.to_string());
        }
        None => lines.push("takes no arguments".to_owned()),
    }
    lines.join("\n")
}
