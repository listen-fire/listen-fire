//! A brand narrows a type (`text & Brand<"claim:email/address">`), as
//! TypeScript's intersection does: a branded value fits where its base is
//! asked for, and plain text never fits where a brand is. Only a module's
//! schema and a plugin's signature declare one; any operation on a branded
//! value drops it, and binding or passing it keeps it.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::json;

fn branded(brands: &[&str]) -> serde_json::Value {
    json!({ "kind": "branded", "of": "text", "brands": brands })
}

fn catalog() -> CatalogSnapshot {
    let email = branded(&["claim:email/address"]);
    let schema = json!({
        "positions": {
            "Message": {
                "properties": {
                    "Email": email,
                    "Work Email": branded(&["claim:email/address", "claim:work/address"]),
                    "Phone": branded(&["claim:phone/e164"]),
                    "Telegram": branded(&["claim:telegram/user_id"]),
                    "Name": "text",
                    "Data": "json"
                },
                "edges": {}
            }
        },
        "collections": { "Messages": { "target": "Message" } },
        "writableRoots": {}
    });
    let catalog = json!({
        "adapters": { "chat": { "canFire": false, "constructionArgs": [], "schemas": { "": schema } } },
        "credentials": {},
        "plugins": {
            "is_member": {
                "args": ["e"], "priced": false, "requiredArgs": ["e"], "argTypes": { "e": email }, "effects": {},
                "output": { "kind": "value", "type": "boolean" }, "package": "@lf-platform/team"
            },
            "reaches": {
                "args": ["to"], "priced": false, "requiredArgs": ["to"],
                "argTypes": { "to": { "kind": "union", "of": [email, branded(&["claim:phone/e164"])] } }, "effects": {},
                "output": { "kind": "value", "type": "boolean" }, "package": "@lf-platform/team"
            }
        }
    });
    CatalogSnapshot::load(&catalog.to_string()).unwrap()
}

/// Every error (a warning is not one).
fn errors_of(source: &str) -> Vec<Diagnostic> {
    let source = format!("import {{ `@lf-platform/team` as t }} from plugins\nimport {{ chat }} from adapters\nc = connect chat\n{source}");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog(), options).unwrap_or_else(|e| panic!("{source}: {e:?}")).into_iter().filter(|d| d.is_error()).collect()
}

/// The errors of `body`, inside a block over the messages (`m`).
fn in_block(body: &str) -> Vec<Diagnostic> {
    errors_of(&format!("function go() {{\n  c-[m:Messages]-> {{\n{body}\n  }}\n}}\n"))
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

#[test]
fn a_branded_field_fits_plain_text() {
    assert_eq!(in_block("    x = m.Email\n    y = Text.lower(x)"), Vec::<Diagnostic>::new());
}

#[test]
fn plain_text_where_a_brand_is_asked_is_refused() {
    let found = in_block("    r = t.isMember(\"a@x.com\")");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
    assert!(found[0].message.contains(r#"text & Brand<"claim:email/address">"#), "{}", found[0].message);
    assert_eq!(codes(&in_block("    r = t.isMember(m.Name)")), ["MOV_BRAND_REQUIRED"]);
}

#[test]
fn an_operation_drops_the_brand() {
    assert_eq!(codes(&in_block("    r = t.isMember(Text.lower(m.Email))")), ["MOV_BRAND_REQUIRED"]);
    assert_eq!(codes(&in_block("    r = t.isMember(\"${m.Email}\")")), ["MOV_BRAND_REQUIRED"]);
    assert_eq!(codes(&in_block("    x = m.Name == \"a\" ? m.Email : m.Email\n    r = t.isMember(x)")), ["MOV_BRAND_REQUIRED"]);
}

#[test]
fn binding_and_parameters_keep_the_brand() {
    assert_eq!(in_block("    x = m.Email\n    r = t.isMember(x)"), Vec::<Diagnostic>::new());
    // A plugin call nested in an operation is still judged as a call.
    assert_eq!(in_block("    r = coalesce(t.isMember(m.Email), false)"), Vec::<Diagnostic>::new());
    assert_eq!(codes(&in_block("    r = coalesce(t.isMember(m.Name), false)")), ["MOV_BRAND_REQUIRED"]);
    let function = "function f(e: <text & Brand<\"claim:email/address\">>) {\n  r = t.isMember(e)\n  return r\n}\n";
    assert_eq!(errors_of(&format!("{function}function go() {{\n  c-[m:Messages]-> {{\n    a = f(m.Email)\n  }}\n}}\n")), Vec::<Diagnostic>::new());
    let plain = errors_of(&format!("{function}function go() {{\n  a = f(\"a@x.com\")\n  return a\n}}\n"));
    assert_eq!(codes(&plain), ["MOV_BRAND_REQUIRED"], "{plain:#?}");
    assert!(plain[0].message.contains(r#"text & Brand<"claim:email/address">"#), "{}", plain[0].message);
}

#[test]
fn several_brands_fit_where_one_is_asked() {
    assert_eq!(in_block("    r = t.isMember(m.`Work Email`)"), Vec::<Diagnostic>::new());
    // A parameter asking for both is not met by a value that has one.
    let both = "function f(e: <text & Brand<\"claim:work/address\"> & Brand<\"claim:email/address\">>) {\n  return 1\n}\n";
    assert_eq!(errors_of(&format!("{both}function go() {{\n  c-[m:Messages]-> {{\n    a = f(m.`Work Email`)\n  }}\n}}\n")), Vec::<Diagnostic>::new());
    assert_eq!(codes(&errors_of(&format!("{both}function go() {{\n  c-[m:Messages]-> {{\n    a = f(m.Email)\n  }}\n}}\n"))), ["MOV_BRAND_REQUIRED"]);
}

#[test]
fn a_union_of_brands_accepts_either_member() {
    assert_eq!(in_block("    r = t.reaches(m.Email)\n    s = t.reaches(m.Phone)"), Vec::<Diagnostic>::new());
    let found = in_block("    r = t.reaches(m.Telegram)");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
    assert!(found[0].message.contains(r#"text & Brand<"claim:email/address"> | text & Brand<"claim:phone/e164">"#), "{}", found[0].message);
    assert!(found[0].message.contains(r#"text & Brand<"claim:telegram/user_id">"#), "{}", found[0].message);
}

#[test]
fn comparison_with_plain_text_checks() {
    assert_eq!(in_block("    b = m.Email == \"a@x.com\""), Vec::<Diagnostic>::new());
}


#[test]
fn a_program_cannot_make_a_branded_value() {
    // No return type launders plain text into a brand.
    let found = errors_of("function f(s: <text>): <text & Brand<\"claim:email/address\">> {\n  return s\n}\n");
    assert_eq!(codes(&found), ["MOV_RETURN_TYPE"], "{found:#?}");
}

#[test]
fn a_branded_type_is_its_base_and_its_brand_set() {
    use movement_checker::types::field::{Ty, branded, field_assignable, field_type_equals, maybe_absent, spell_type, unbranded, value_union};
    let brand = |names: &[&str]| branded(Ty::Text, names.iter().map(|n| n.to_string()));
    // Equal only when the bases and the brand sets are, whatever the order.
    assert!(field_type_equals(&brand(&["a", "b"]), &brand(&["b", "a"])));
    assert!(!field_type_equals(&brand(&["a"]), &brand(&["a", "b"])));
    assert!(!field_type_equals(&brand(&["a"]), &branded(Ty::Number, ["a".to_string()])));
    assert!(!field_type_equals(&brand(&["a"]), &Ty::Text));
    // Fit: more brands fit fewer, never the other way, and plain never fits a brand.
    assert!(field_assignable(&brand(&["a", "b"]), &brand(&["a"])));
    assert!(!field_assignable(&brand(&["a"]), &brand(&["a", "b"])));
    assert!(field_assignable(&brand(&["a"]), &Ty::Text));
    assert!(!field_assignable(&Ty::Text, &brand(&["a"])));
    // A union keeps two brands apart, and the plain base absorbs its brands.
    assert_eq!(spell_type(&value_union(&[brand(&["b"]), brand(&["a"]), brand(&["a"])]).unwrap()), r#"text & Brand<"a"> | text & Brand<"b">"#);
    assert_eq!(spell_type(&value_union(&[brand(&["a"]), Ty::Text]).unwrap()), "text");
    // A brand sits under absence and on each member of a union; dropping it is deep.
    assert_eq!(spell_type(&branded(maybe_absent(Ty::Text), ["a".to_string()])), r#"text & Brand<"a"> | null"#);
    assert_eq!(spell_type(&branded(brand(&["b"]), ["a".to_string()])), r#"text & Brand<"a"> & Brand<"b">"#);
    assert_eq!(spell_type(&unbranded(&Ty::list(maybe_absent(brand(&["a"]))))), "(text | null)[]");
}

#[test]
fn an_unknown_value_never_fits_a_brand() {
    let found = in_block("    r = t.isMember(ai(\"who\"))");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
    let function = "function f(e: <text & Brand<\"claim:email/address\">>) {\n  return 1\n}\n";
    let found = errors_of(&format!("{function}function go() {{\n  a = f(ai(\"who\"))\n  return a\n}}\n"));
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
}

#[test]
fn a_declared_branded_return_is_no_cast() {
    let found = errors_of("function f(): <text & Brand<\"claim:email/address\">> {\n  return ai(\"who\")\n}\n");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
}

#[test]
fn json_never_fits_a_brand() {
    let found = in_block("    r = t.isMember(m.Data)");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
    let function = "function f(e: <text & Brand<\"claim:email/address\">>) {\n  return 1\n}\n";
    let found = errors_of(&format!("{function}function go() {{\n  c-[m:Messages]-> {{\n    a = f(m.Data)\n  }}\n}}\n"));
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
    let found = errors_of("function f(d: <json>): <text & Brand<\"claim:email/address\">> {\n  return d\n}\n");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
}
