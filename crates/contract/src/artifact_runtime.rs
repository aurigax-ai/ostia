#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeModule {
    pub specifier: &'static str,
    pub package: &'static str,
    pub about: &'static str,
    pub entry: Option<&'static str>,
}

const fn module(
    specifier: &'static str,
    package: &'static str,
    about: &'static str,
) -> RuntimeModule {
    RuntimeModule {
        specifier,
        package,
        about,
        entry: None,
    }
}

pub const ARTIFACT_RUNTIME: [RuntimeModule; 10] = [
    module("react", "react", "React 18"),
    module(
        "react/jsx-runtime",
        "react",
        "the JSX runtime (used by compiled .jsx/.tsx; never import it yourself)",
    ),
    module("react-dom", "react-dom", "React DOM"),
    module("react-dom/client", "react-dom", "createRoot"),
    module("recharts", "recharts", "charts"),
    module("lucide-react", "lucide-react", "icons"),
    module("@phosphor-icons/react", "@phosphor-icons/react", "icons"),
    module("d3", "d3", "data visualisation"),
    module("papaparse", "papaparse", "CSV parsing"),
    RuntimeModule {
        specifier: "sql.js",
        package: "sql.js",
        about: "SQLite, asm.js build with a growing heap (no WASM)",
        entry: Some("sql.js/dist/sql-asm-memory-growth.js"),
    },
];

pub const TAILWIND_PACKAGE: &str = "tailwindcss";
pub const RUNTIME_MODULES: &str = "node_modules";
pub const RUNTIME_NOTICES: &str = "THIRD-PARTY-NOTICES.txt";

pub fn runtime_packages() -> Vec<&'static str> {
    let mut packages: Vec<&'static str> = Vec::new();
    for package in ARTIFACT_RUNTIME
        .iter()
        .map(|module| module.package)
        .chain([TAILWIND_PACKAGE])
    {
        if !packages.contains(&package) {
            packages.push(package);
        }
    }
    packages
}

pub fn allows_runtime_import(specifier: &str) -> bool {
    ARTIFACT_RUNTIME
        .iter()
        .any(|module| module.specifier == specifier)
}

pub fn runtime_entry(specifier: &str) -> &str {
    ARTIFACT_RUNTIME
        .iter()
        .find(|module| module.specifier == specifier)
        .and_then(|module| module.entry)
        .unwrap_or(specifier)
}

pub fn importable_specifiers() -> Vec<&'static str> {
    ARTIFACT_RUNTIME
        .iter()
        .filter(|module| module.specifier != "react/jsx-runtime")
        .map(|module| module.specifier)
        .collect()
}
