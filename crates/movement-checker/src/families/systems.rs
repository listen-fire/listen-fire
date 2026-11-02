//! Systems: constructing an adapter instance, the credential it names, and
//! an adapter used where only an instance will do.
//!
//! Codes: MOV_CONSTRUCT_NOT_ADAPTER, MOV_CONSTRUCT_BAD_ARG,
//! MOV_CONSTRUCT_MISSING_CRED, MOV_CONSTRUCT_UNKNOWN_OPTION,
//! MOV_CRED_WRONG_ADAPTER, MOV_ADAPTER_NOT_CONSTRUCTED, MOV_AI_TIER_LEGACY.
//! Not ported: MOV_OPTION_INVALID (typing.ts `typeOptionsMap`), which types
//! each option of a built-in's options map and needs expression typing.
//!
//! TypeScript: check.ts `checkConstruction`, `checkCredentialArg`,
//! `importedCredentialName`, `callInConstructPosition`, the parameter loop of
//! `checkMovement`, `checkPathHead`; typing.ts `aiTierDiagnostics`.

use indexmap::IndexMap;
use movement_parser::ast::{ConstructionCall, ExprSlot, ParamTypeRef, Span, TypeRef};
use movement_parser::catalog::helpers::{credential_arg_of, unwrap_credential_arg};
use movement_parser::catalog::snapshot::Args;
use movement_parser::catalog::types::{InstanceSchema, JsMap};
use movement_parser::surface::phrase::{Connection, connection};
use movement_parser::lowering::expression::{Expression, StaticValue};
use serde_json::json;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};
use crate::meta::closest_by_edit_distance;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::slots::expression_of_slot;

/// `DRY_RUN_ARG`: the platform argument every construction accepts.
pub const DRY_RUN_ARG: &str = "dry_run";

/// `AI_TIERS`, and the spellings that predate them (`AI_TIER_ALIASES`).
const AI_TIERS: &[&str] = &["quick", "careful", "thorough"];
const AI_TIER_ALIASES: &[(&str, &str)] = &[("smart", "careful")];

/// `BOOLEAN_LITERAL`.
pub fn is_boolean_literal(raw: &str) -> bool {
    raw.eq_ignore_ascii_case("true") || raw.eq_ignore_ascii_case("false")
}

/// What a constructed instance carries on its symbol: the adapter, the
/// credential it was built with, the schema that pair instantiates, and its
/// other arguments raw (the entry position rides there).
// The instance positions are typed against, with its identity (the system
// address, `addressToken`), is the type core's; this holds only what the
// listen and construction rules read.
#[derive(Debug, Default)]
pub struct Instance {
    pub adapter: Option<String>,
    pub credential: Option<String>,
    pub schema: Option<InstanceSchema>,
    pub construction_args: IndexMap<String, String>,
}

/// What `checkConstruction` learned.
#[derive(Default)]
pub struct Constructed {
    pub adapter: Option<String>,
    pub credential: Option<String>,
    pub schema: Option<InstanceSchema>,
}

impl Checker<'_> {
    /// `checkConstruction`: the adapter, credential and schema a construction
    /// builds, its arguments checked against the adapter's signature.
    pub fn check_construction(&mut self, construct: &ConstructionCall, scope: ScopeId) -> Constructed {
        let Some(adapter) = self.constructed_adapter(construct, scope) else { return Constructed::default() };
        let Some(spec) = self.catalog.adapter(&adapter) else {
            return Constructed { adapter: Some(adapter), ..Constructed::default() };
        };
        let credential_arg = credential_arg_of(spec).cloned();
        let credential = credential_arg
            .as_ref()
            .and_then(|c| construct.args.iter().find(|a| a.name == c.name))
            .map(|a| self.imported_credential_name(a.value.raw.trim(), scope));
        let accepted: Vec<String> = spec.construction_args.iter().map(|a| a.name.clone()).collect();
        let mut saw_credential = false;
        for arg in &construct.args {
            if arg.name == DRY_RUN_ARG {
                if !is_boolean_literal(arg.value.raw.trim()) {
                    self.report(
                        codes::CONSTRUCT_BAD_ARG,
                        format!("'{DRY_RUN_ARG}' takes a boolean literal — write {DRY_RUN_ARG}: true (or false)"),
                        arg.value.span,
                    );
                }
                continue;
            }
            if !accepted.contains(&arg.name) {
                self.report(
                    codes::CONSTRUCT_BAD_ARG,
                    format!(
                        "'{}' does not accept a construction argument '{}' — it accepts: {}",
                        construct.callee,
                        arg.name,
                        accepted.join(", ")
                    ),
                    arg.value.span,
                );
                continue;
            }
            if credential_arg.as_ref().is_some_and(|c| c.name == arg.name) {
                saw_credential = true;
                self.check_credential_arg(&adapter, &arg.value, scope);
                continue;
            }
            self.check_expr_slot(&arg.value, scope);
            let options = self.catalog.construction_arg_options(&adapter, credential.as_deref(), &arg.name);
            if let (Some(options), Some(literal)) = (options, static_string_literal_of(&arg.value))
                && !options.is_empty()
                && !options.contains(&literal)
            {
                let tried: Vec<String> = options.iter().map(|o| format!("\"{o}\"")).collect();
                let mut warning = Diagnostic::error(
                    codes::CONSTRUCT_UNKNOWN_OPTION,
                    format!("'{}' value \"{literal}\" isn't one this connection can see — try: {}", arg.name, tried.join(", ")),
                    arg.value.span,
                );
                warning.severity = Some(Severity::Warning);
                self.push(warning);
            }
        }
        if let Some(credential_arg) = &credential_arg
            && credential_arg.required
            && !saw_credential
        {
            self.report(
                codes::CONSTRUCT_MISSING_CRED,
                format!("'{0}' needs a credential to connect with: 'connect {0} using <credential>'", construct.callee),
                construct.span,
            );
        }
        let mut args = IndexMap::new();
        for arg in construct.args.iter().filter(|a| a.name != DRY_RUN_ARG) {
            let raw = arg.value.raw.trim();
            let value = if credential_arg.as_ref().is_some_and(|c| c.name == arg.name) {
                self.imported_credential_name(raw, scope)
            } else {
                raw.to_string()
            };
            args.insert(arg.name.clone(), value);
        }
        let schema = self.catalog.instantiate(&adapter, &Args::from(JsMap(args))).cloned();
        Constructed { adapter: Some(adapter), credential, schema }
    }

    /// The adapter a construction names, its failure reported: one an import
    /// binds, else, written with `connect`, the catalog's adapter of that key.
    /// `connect`'s adapter is a position of its own, as a type is in
    /// TypeScript, so a binding of the same name does not hide it.
    fn constructed_adapter(&mut self, construct: &ConstructionCall, scope: ScopeId) -> Option<String> {
        if let Some(adapter) = self.connected_adapter(construct, scope) {
            return Some(adapter);
        }
        let resolution = self.scopes.resolve(scope, &construct.callee);
        let found = match resolution {
            Resolution::Found(id) => Some(self.scopes.symbol(id)),
            _ => None,
        };
        if found.is_none() && self.catalog.adapter(&construct.callee).is_some() {
            self.report_adapter_construction(construct);
            return None;
        }
        let Some(symbol) = found else {
            if construct.connect && matches!(resolution, Resolution::Unknown) {
                self.report_unknown_adapter(&construct.callee, construct.span);
            } else {
                self.report_resolution_failure(&construct.callee, construct.span, resolution);
            }
            return None;
        };
        let message = if symbol.unit {
            format!("'{0}' is one of the run host's units, always connected — listen to it by name ('listen to {0} … fire …') with no import and no 'connect'", construct.callee)
        } else if symbol.kind == SymbolKind::FileImport {
            format!("'{}' is imported from a file (a movement or a node declaration) — only adapter types are constructed", construct.callee)
        } else {
            format!("'{}' is {}, not an adapter type — only adapter types are constructed", construct.callee, symbol.kind.describe())
        };
        self.report(codes::CONSTRUCT_NOT_ADAPTER, message, construct.span);
        None
    }

    /// The adapter a construction names, when it names one:
    /// `constructed_adapter` without the reports, for the typing pass.
    pub(crate) fn connected_adapter(&self, construct: &ConstructionCall, scope: ScopeId) -> Option<String> {
        let found = match self.scopes.resolve(scope, &construct.callee) {
            Resolution::Found(id) => Some(self.scopes.symbol(id)),
            _ => None,
        };
        if let Some(symbol) = found
            && symbol.kind == SymbolKind::Adapter
        {
            return Some(symbol.imported_name.clone().unwrap_or_else(|| construct.callee.clone()));
        }
        let unit = found.is_some_and(|s| s.unit);
        (construct.connect && !unit && self.catalog.adapter(&construct.callee).is_some()).then(|| construct.callee.clone())
    }

    /// `connect x` where no adapter is called `x`: the adapters there are,
    /// the closest named first.
    fn report_unknown_adapter(&mut self, written: &str, span: Span) {
        let units = movement_parser::version::RUN_HOST_UNITS;
        let names: Vec<String> = self.catalog.adapters.keys().filter(|k| !units.contains(&k.as_str())).cloned().collect();
        let hint = closest_by_edit_distance(written, &names).map(|n| format!(" — did you mean '{n}'?")).unwrap_or_default();
        let listed = if names.is_empty() { "none".to_string() } else { names.join(", ") };
        self.report(codes::NAME_UNRESOLVED, format!("'{written}' is no adapter here{hint} (the adapters: {listed})"), span);
    }

    /// `crm = attio(credentials: acme)` with no import: the older
    /// construction, refused with the `connect` it is now written as.
    fn report_adapter_construction(&mut self, construct: &ConstructionCall) {
        let credential = self.catalog.adapter(&construct.callee).and_then(credential_arg_of).map_or("credentials".to_string(), |a| a.name.clone());
        let args: Vec<(&str, &str)> = construct.args.iter().map(|a| (a.name.as_str(), a.value.raw.trim())).collect();
        let text = connection(&Connection { adapter: &construct.callee, args: &args, credential: Some(&credential) });
        let mut diagnostic = Diagnostic::error(codes::NAME_UNRESOLVED, format!("an adapter is set up with `{text}`"), construct.span);
        diagnostic.fix = Some(json!({ "edits": [{ "span": construct.span, "text": text }] }));
        self.push(diagnostic);
    }

    /// The instance a construction bound to a name declares.
    pub fn instance_of(&self, construct: &ConstructionCall, constructed: Constructed) -> Instance {
        let credential_arg = self
            .catalog
            .adapter(constructed.adapter.as_deref().unwrap_or(&construct.callee))
            .and_then(credential_arg_of)
            .map_or("credentials", |a| a.name.as_str());
        let construction_args =
            construct.args.iter().filter(|a| a.name != credential_arg).map(|a| (a.name.clone(), a.value.raw.clone())).collect();
        Instance { adapter: constructed.adapter, credential: constructed.credential, schema: constructed.schema, construction_args }
    }

    /// `importedCredentialName`: the catalog's name for a credential named locally.
    pub(crate) fn imported_credential_name(&self, local: &str, scope: ScopeId) -> String {
        let name = unwrap_credential_arg(local).unwrap_or_else(|| local.to_string());
        match self.scopes.resolve(scope, &name) {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Credential => {
                self.scopes.symbol(id).imported_name.clone().unwrap_or(name)
            }
            _ => name,
        }
    }

    /// `checkCredentialArg`.
    fn check_credential_arg(&mut self, adapter: &str, slot: &ExprSlot, scope: ScopeId) {
        let Some(name) = unwrap_credential_arg(slot.raw.trim()) else {
            let repair = self.credential_arg_repair(slot);
            let mut message = "The credential after 'using' is a credential's name, not an expression".to_string();
            if let Some((instruction, _)) = &repair {
                message.push_str(&format!(" — {instruction}"));
            }
            let mut diagnostic = Diagnostic::error(codes::CRED_WRONG_ADAPTER, message, slot.span);
            if let Some((_, edits)) = repair {
                diagnostic.fix = Some(json!({ "edits": edits }));
            }
            self.push(diagnostic);
            return;
        };
        // A credential an import binds, else the catalog's of that name: the
        // name after `using` is only ever a credential.
        let resolution = self.scopes.resolve(scope, &name);
        let imported = match resolution {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Credential => {
                self.scopes.symbol(id).imported_name.clone().unwrap_or_else(|| name.clone())
            }
            _ if self.catalog.credential(&name).is_some() => name.clone(),
            Resolution::Found(id) => {
                let message = format!("'{name}' is {}, not a credential", self.scopes.symbol(id).kind.describe());
                return self.report(codes::CRED_WRONG_ADAPTER, message, slot.span);
            }
            Resolution::Unknown => return self.report_unknown_credential(adapter, &name, slot.span),
            failure => return self.report_resolution_failure(&name, slot.span, failure),
        };
        if let Some(served) = self.catalog.credential(&imported).map(|c| c.adapters)
            && !served.iter().any(|a| a == adapter)
        {
            self.report(
                codes::CRED_WRONG_ADAPTER,
                format!("'{name}' is a {} credential — '{adapter}' needs a {adapter} credential", served.join(", ")),
                slot.span,
            );
            return;
        }
        let filled = self.catalog.credential(&imported).and_then(|c| c.credential);
        let declared = self.catalog.adapter(adapter).and_then(|a| a.declared_credentials.clone());
        if let (Some(filled), Some(declared)) = (filled, declared)
            && !declared.contains(&filled)
        {
            self.report(
                codes::CRED_WRONG_ADAPTER,
                format!(
                    "'{name}' is {adapter}'s '{filled}' credential, which '{adapter}' does not declare — {}",
                    declared_credentials_phrase(adapter, &declared)
                ),
                slot.span,
            );
        }
    }

    /// `using c` where no credential is called `c`: the adapter's credentials,
    /// the closest named first.
    fn report_unknown_credential(&mut self, adapter: &str, written: &str, span: Span) {
        let names: Vec<String> = self
            .catalog
            .credential_names()
            .into_iter()
            .filter(|name| self.catalog.credential(name).is_some_and(|c| c.adapters.iter().any(|a| a == adapter)))
            .map(str::to_string)
            .collect();
        let hint = closest_by_edit_distance(written, &names).map(|n| format!(" — did you mean '{n}'?")).unwrap_or_default();
        let listed = if names.is_empty() { format!("none for {adapter} yet") } else { names.join(", ") };
        self.report(codes::NAME_UNRESOLVED, format!("'{written}' is no credential here{hint} (the {adapter} credentials: {listed})"), span);
    }

    /// A movement parameter typed against an adapter rather than an instance
    /// (the parameter loop of `checkMovement`). `graph` is what the type's
    /// name resolved to.
    pub fn check_param_source(&mut self, type_: &TypeRef, graph: Option<SymbolId>) {
        let Some(symbol) = graph.map(|id| self.scopes.symbol(id)) else { return };
        if symbol.kind != SymbolKind::Adapter {
            return;
        }
        let adapter = symbol.imported_name.clone().unwrap_or_else(|| symbol.name.clone());
        let position = type_.position.clone().unwrap_or_else(|| if adapter == "cron" { "tick".into() } else { "invocation".into() });
        let message = format!(
            "'{}' is an adapter, not an instance — construct an instance and name it first: 'go = {}', then type the parameter against the name ('<go-[:{position}]->>') and listen to it ('listen to go-[:…]-> fire f')",
            type_.graph,
            self.construction_call(&adapter)
        );
        self.report(codes::ADAPTER_NOT_CONSTRUCTED, message, type_.span);
    }

    /// A bare adapter as a path's root (`checkPathHead`).
    pub fn check_path_root_constructed(&mut self, root: &str, root_symbol: Option<SymbolId>, hops_raw: &str, span: Span) {
        let Some(symbol) = root_symbol.map(|id| self.scopes.symbol(id)) else { return };
        if symbol.kind != SymbolKind::Adapter {
            return;
        }
        let adapter = symbol.imported_name.clone().unwrap_or_else(|| symbol.name.clone());
        let message = format!(
            "'{root}' is an adapter, not an instance — construct and name an instance first, then walk or write from the name: 'go = {}' … 'go{hops_raw}'",
            self.construction_call(&adapter)
        );
        self.report(codes::ADAPTER_NOT_CONSTRUCTED, message, span);
    }

    /// `aiTierDiagnostics` at an `extract` statement, which carries its tier.
    pub fn check_ai_tier(&mut self, written: Option<&str>, span: Span) {
        let Some(written) = written else { return };
        if AI_TIERS.contains(&written) {
            return;
        }
        let tiers = AI_TIERS.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(" | ");
        if let Some((_, tier)) = AI_TIER_ALIASES.iter().find(|(old, _)| *old == written) {
            let mut info = Diagnostic::error(
                codes::AI_TIER_LEGACY,
                format!(
                    "\"{written}\" is the old spelling of the \"{tier}\" tier and still means it — write `\"{tier}\"` instead, which is the word the tiers are named in ({tiers})."
                ),
                span,
            );
            info.severity = Some(Severity::Info);
            return self.push(info);
        }
        let mut message = format!("\"{written}\" isn't a tier — expected one of: {tiers}.");
        if let Some(closest) = closest_by_edit_distance(written, AI_TIERS) {
            message.push_str(&format!(" Did you mean \"{closest}\"?"));
        }
        self.report(codes::ENUM_UNKNOWN_VALUE, message, span);
    }
}

/// `staticStringLiteralOf`: the value of a slot that is one string literal.
pub fn static_string_literal_of(slot: &ExprSlot) -> Option<String> {
    match expression_of_slot(slot).ok()? {
        Expression::Static { value: StaticValue::String(value) } => Some(value),
        _ => None,
    }
}

/// Whether a parameter's written type names a value rather than a position
/// (`movementParamValueType` is defined): a scalar, or a declared enum.
pub fn is_value_param_type(checker: &Checker<'_>, type_: &ParamTypeRef, scope: ScopeId) -> bool {
    let ParamTypeRef::Name(reference) = type_ else { return true };
    if reference.hops_raw.is_some() {
        return false;
    }
    if movement_parser::catalog::helpers::parse_field_type_name(Some(&reference.graph)).is_some() {
        return true;
    }
    checker.declared_type_in(&reference.graph, scope).is_some()
}

/// What a module declares, for a credential that fills none of it
/// (check.ts `declaredCredentialsPhrase`).
fn declared_credentials_phrase(adapter: &str, declared: &[String]) -> String {
    if declared.is_empty() {
        return format!("'{adapter}' takes no credential of its own");
    }
    let names: Vec<String> = declared.iter().map(|d| format!("'{d}'")).collect();
    format!("connect it using a {} credential of {adapter}", names.join(" or "))
}
