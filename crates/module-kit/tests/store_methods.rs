//! A store module built on the kit serves every method listen-fire's store client
//! calls: the client's wire names are the contract's, and the kit's table is
//! what a Rust store module is built from.

const LF_STORE_CLIENT: &str = include_str!("../../lf/src/store_module.rs");
const KIT_STORE_TABLE: &str = include_str!("../src/core.rs");

/// Every `"group.method"` literal in `source`.
fn wire_names(source: &str) -> Vec<&str> {
    source
        .split('"')
        .skip(1)
        .step_by(2)
        .filter(|literal| {
            let Some((group, method)) = literal.split_once('.') else { return false };
            !group.is_empty()
                && group.chars().all(|c| c.is_ascii_lowercase())
                && !method.is_empty()
                && method.chars().all(|c| c.is_ascii_alphabetic())
        })
        .collect()
}

#[test]
fn the_kit_table_has_every_method_lfs_store_client_calls() {
    let served = wire_names(KIT_STORE_TABLE);
    let called = wire_names(LF_STORE_CLIENT);
    assert!(called.len() > 50, "the scan found only {} calls; it no longer reads the client", called.len());
    let missing: Vec<&&str> = called.iter().filter(|name| !served.contains(name)).collect();
    assert!(missing.is_empty(), "listen-fire's store client calls methods the kit's store table lacks: {missing:?}");
}
