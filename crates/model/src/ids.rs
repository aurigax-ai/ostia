#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IdNamespace(String);

impl IdNamespace {
    pub fn new(namespace: impl Into<String>) -> Self {
        Self(namespace.into())
    }

    pub fn id(&self, prefix: &str, separator: &str, number: u64) -> String {
        if self.0.is_empty() {
            format!("{prefix}{separator}{number}")
        } else {
            format!("{prefix}{separator}{}-{number}", self.0)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct IdMint {
    namespace: IdNamespace,
    counter: u64,
}

impl IdMint {
    pub fn new(namespace: IdNamespace) -> Self {
        Self {
            namespace,
            counter: 0,
        }
    }

    pub fn next(&mut self, prefix: &str, separator: &str) -> String {
        self.counter += 1;
        self.namespace.id(prefix, separator, self.counter)
    }

    pub fn adopt(&mut self, number: u64) {
        self.counter = self.counter.max(number);
    }
}
