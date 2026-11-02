use ostia_base::js::non_empty;

#[derive(Clone, Debug, Default)]
pub struct HomeDir {
    home: Option<String>,
}

impl HomeDir {
    pub fn get(&self) -> Option<&str> {
        self.home.as_deref()
    }

    pub fn load<E>(&mut self, info_home: Result<String, E>) {
        self.home = info_home
            .ok()
            .and_then(|home| non_empty(Some(&home)).map(str::to_owned));
    }
}
