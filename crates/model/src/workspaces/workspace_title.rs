pub fn workspace_title<'a>(name: &'a str, custom_name: Option<&'a str>) -> &'a str {
    custom_name.unwrap_or(name)
}
