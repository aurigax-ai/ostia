fn is_safe_word(arg: &str) -> bool {
    !arg.is_empty()
        && arg
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "@%+:,./_-".contains(ch))
}

pub fn quote_arg(arg: &str) -> String {
    if is_safe_word(arg) {
        return arg.to_owned();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

pub fn quote_argv(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| quote_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
}
