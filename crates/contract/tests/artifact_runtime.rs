#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::artifact_runtime::{
    ARTIFACT_RUNTIME, RUNTIME_MODULES, RUNTIME_NOTICES, TAILWIND_PACKAGE, allows_runtime_import,
    importable_specifiers, runtime_entry, runtime_packages,
};

#[test]
fn is_the_approved_set_react_recharts_lucide_phosphor_d3_papaparse_sql_js_and_tailwind() {
    let specifiers: Vec<&str> = ARTIFACT_RUNTIME
        .iter()
        .map(|module| module.specifier)
        .collect();
    assert_eq!(
        specifiers,
        [
            "react",
            "react/jsx-runtime",
            "react-dom",
            "react-dom/client",
            "recharts",
            "lucide-react",
            "@phosphor-icons/react",
            "d3",
            "papaparse",
            "sql.js",
        ]
    );
    assert_eq!(TAILWIND_PACKAGE, "tailwindcss");
}

#[test]
fn allows_only_the_listed_specifiers_exactly() {
    let mut listed = importable_specifiers();
    listed.push("react/jsx-runtime");
    for specifier in listed {
        assert!(allows_runtime_import(specifier), "{specifier}");
    }
    for specifier in [
        "lodash",
        "react-dom/server",
        "d3-scale",
        "/runtime/react.js",
        "tailwindcss",
    ] {
        assert!(!allows_runtime_import(specifier), "{specifier}");
    }
}

#[test]
fn runs_sql_js_as_its_asm_build_never_the_wasm_one() {
    assert_eq!(
        runtime_entry("sql.js"),
        "sql.js/dist/sql-asm-memory-growth.js"
    );
    assert_eq!(runtime_entry("d3"), "d3");
    assert!(allows_runtime_import("sql.js"));
    assert!(!allows_runtime_import("sql.js/dist/sql-wasm.js"));
}

#[test]
fn names_each_package_once_and_ends_with_tailwind() {
    assert_eq!(
        runtime_packages(),
        [
            "react",
            "react-dom",
            "recharts",
            "lucide-react",
            "@phosphor-icons/react",
            "d3",
            "papaparse",
            "sql.js",
            "tailwindcss",
        ]
    );
}

#[test]
fn leaves_the_jsx_runtime_out_of_the_importable_specifiers() {
    let importable = importable_specifiers();
    assert!(!importable.contains(&"react/jsx-runtime"));
    assert_eq!(importable.len(), ARTIFACT_RUNTIME.len() - 1);
    assert_eq!(importable[0], "react");
    assert_eq!(importable[1], "react-dom");
}

#[test]
fn keeps_the_names_of_the_built_tree() {
    assert_eq!(RUNTIME_MODULES, "node_modules");
    assert_eq!(RUNTIME_NOTICES, "THIRD-PARTY-NOTICES.txt");
}
