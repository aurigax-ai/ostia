use ostia_model::files::home_dir::HomeDir;

#[test]
fn has_no_home_before_it_loads() {
    assert_eq!(HomeDir::default().get(), None);
}

#[test]
fn keeps_the_home_that_the_app_info_reports() {
    let mut home = HomeDir::default();
    home.load(Ok::<_, ()>("/home/u".to_owned()));
    assert_eq!(home.get(), Some("/home/u"));
}

#[test]
fn an_empty_home_is_no_home() {
    let mut home = HomeDir::default();
    home.load(Ok::<_, ()>(String::new()));
    assert_eq!(home.get(), None);
}

#[test]
fn a_failed_read_clears_a_home_that_was_loaded_before() {
    let mut home = HomeDir::default();
    home.load(Ok::<_, ()>("/home/u".to_owned()));
    home.load(Err("no info"));
    assert_eq!(home.get(), None);
}

#[test]
fn a_later_load_replaces_the_home() {
    let mut home = HomeDir::default();
    home.load(Ok::<_, ()>("/home/a".to_owned()));
    home.load(Ok::<_, ()>("/home/b".to_owned()));
    assert_eq!(home.get(), Some("/home/b"));
}
