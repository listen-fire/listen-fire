//! The check as a language service reads it: besides its diagnostics, what
//! the walk settled, kept — every scope with the text it covers, every
//! symbol with its type, and the import link. A position in the file is
//! answered from these (docs/contracts/language-service.md); nothing here
//! walks the program a second time.

use movement_parser::ast::{Loc, Program, Span};
use movement_parser::catalog::types::CatalogSnapshot;

use crate::families::names::{read_before_binding, unknown_name};
use crate::scope::{Resolution, ScopeId, Scopes, Symbol, SymbolId, SymbolKind};
use crate::slots::{SlotError, collect_expression_names, expression_of_text};
use crate::types::field::{CollectionOrder, Ty, describe_field_type, record_head_position};
use crate::types::infer::{TypeEnv, Typing};
use crate::types::narrowing::{EntryRead, PresenceProof};
use crate::types::position::{ClosureType, InstanceRef, Position, describe_position};
use crate::types::scope_env::ScopeEnv;
use crate::{CheckOptions, Diagnostic, codes, families, host};

/// An imported name and the declaration it resolved to in its library.
#[derive(Debug, Clone)]
pub struct ImportedDeclaration {
    pub local: String,
    /// The catalog's key for the library (its path under the movements folder).
    pub file: String,
    pub name: String,
    pub span: Span,
}

/// What one check of a program settled.
pub struct Analysis {
    pub diagnostics: Vec<Diagnostic>,
    pub scopes: Scopes,
    /// The program's own file scope.
    pub file_scope: ScopeId,
    /// Each scope a body opens, with the text it covers.
    pub extents: Vec<(Span, ScopeId)>,
    pub imports: Vec<ImportedDeclaration>,
    /// Functions declared with a name, typed as the closures they are.
    pub function_values: std::collections::HashMap<SymbolId, ClosureType>,
    /// What `type_walk` types against, as the check's own typing does.
    nodes: families::nodes::NodeState,
    entry_reads: std::collections::HashMap<String, (EntryRead, String)>,
}

/// One walk's text to type from a place in a checked file (`Analysis::type_walk`).
pub struct WalkQuery<'a> {
    pub at: Loc,
    pub text: &'a str,
    /// Describe the walk rather than read along it: it follows any edge, and
    /// no read is refused for the edge itself. Off, the walk is typed as a
    /// program's would be there.
    pub describing: bool,
    /// The host's zone database: the check's is not kept, whose borrow ends with it.
    pub zones: &'a dyn host::ZoneLookup,
}

/// What a walk's text comes to.
pub struct WalkTyped {
    /// Where the walk lands; for any other text, the record it holds, if one.
    pub landing: Option<Position>,
    /// The whole text's type: a field's, where the text reads one off the landing.
    pub ty: Option<Ty>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Checks `program` and keeps what the walk settled.
pub fn analyze(program: &Program, catalog: &CatalogSnapshot, options: CheckOptions) -> Analysis {
    let (diagnostics, mut checker) = crate::run_check(program, catalog, options);
    let imports = checker
        .imports
        .link()
        .map(|link| {
            link.imports
                .iter()
                .filter_map(|(local, export)| {
                    let file = link.files.get(&export.file)?;
                    let span = file.program.statements.iter().find_map(|s| match s {
                        movement_parser::ast::Statement::Movement(m) if m.name == export.name => Some(m.span),
                        movement_parser::ast::Statement::Shape(s) if s.name == export.name => Some(s.span),
                        _ => None,
                    })?;
                    Some(ImportedDeclaration { local: local.clone(), file: export.file.clone(), name: export.name.clone(), span })
                })
                .collect()
        })
        .unwrap_or_default();
    Analysis {
        diagnostics,
        scopes: std::mem::take(&mut checker.scopes),
        file_scope: ScopeId(0),
        extents: std::mem::take(&mut checker.extents),
        imports,
        function_values: std::mem::take(&mut checker.function_values),
        nodes: std::mem::take(&mut checker.nodes),
        entry_reads: std::mem::take(&mut checker.entry_reads),
    }
}

fn before(a: Loc, b: Loc) -> bool {
    (a.line, a.col) <= (b.line, b.col)
}

fn contains(span: &Span, at: Loc) -> bool {
    before(span.start, at) && before(at, span.end)
}

fn size(span: &Span) -> (usize, usize) {
    (span.end.line - span.start.line, span.end.col.wrapping_sub(span.start.col))
}

/// A symbol a position sees.
pub struct Visible<'a> {
    pub id: SymbolId,
    pub symbol: &'a Symbol,
}

/// A declaration hoisted to its list's top, seen from anywhere in it.
fn is_hoisted(symbol: &Symbol) -> bool {
    symbol.unit || matches!(symbol.kind, SymbolKind::Movement | SymbolKind::Shape | SymbolKind::Type)
}

/// The scope at a place in a file: only what is bound above it. Every name
/// goes through `bound_above`, so a name bound further down reads as unbound
/// whichever of these asks.
struct EnvAt<'a> {
    analysis: &'a Analysis,
    at: Loc,
    scope: ScopeEnv<'a>,
}

impl EnvAt<'_> {
    fn symbol(&self, name: &str) -> Option<&Symbol> {
        self.binding_of(name).map(|id| self.analysis.symbol(id))
    }
}

impl TypeEnv for EnvAt<'_> {
    fn resolve_root(&self, name: &str) -> Option<Position> {
        let id = self.binding_of(name)?;
        let symbol = self.analysis.symbol(id);
        symbol.types.pos.clone().or_else(|| self.analysis.function_values.get(&id).cloned().map(Position::Closure)).or_else(|| self.analysis.nodes.walk_root(id))
    }

    fn resolve_scalar(&self, name: &str) -> Option<Ty> {
        self.symbol(name)?.types.field.clone()
    }

    fn undescribed_event(&self, name: &str) -> Option<families::walks::UndescribedEvent> {
        self.symbol(name)?.undescribed_event.clone()
    }

    fn resolve_may_hold(&self, name: &str) -> Option<Ty> {
        self.symbol(name)?.types.may_hold.clone()
    }

    fn name_in_scope(&self, name: &str) -> bool {
        self.binding_of(name).is_some()
    }

    fn value_names_in_scope(&self) -> Vec<String> {
        self.scope.value_names_in_scope().into_iter().filter(|name| self.name_in_scope(name)).collect()
    }

    fn is_record_name(&self, name: &str) -> bool {
        self.symbol(name).is_some_and(|symbol| symbol.types.is_record)
    }

    fn plural_order_of(&self, name: &str) -> Option<CollectionOrder> {
        self.symbol(name)?.types.plural
    }

    fn is_many_valued_name(&self, name: &str) -> bool {
        self.symbol(name).is_some_and(|symbol| symbol.types.many_valued)
    }

    fn is_declared_graph(&self, instance: &InstanceRef) -> bool {
        self.scope.is_declared_graph(instance)
    }

    fn is_zone(&self, zone: &str) -> Option<bool> {
        self.scope.is_zone(zone)
    }

    fn same_entry(&self, proof: &PresenceProof) -> Vec<PresenceProof> {
        self.scope.same_entry(proof)
    }

    fn entry_read_text(&self, name: &str) -> Option<String> {
        self.scope.entry_read_text(name)
    }

    fn binding_of(&self, name: &str) -> Option<SymbolId> {
        self.analysis.bound_above(self.at, name)
    }
}

impl Analysis {
    /// The innermost scope whose text holds `at` (1-based line and column).
    pub fn scope_at(&self, at: Loc) -> ScopeId {
        self.extents
            .iter()
            .filter(|(span, _)| contains(span, at))
            .min_by_key(|(span, _)| size(span))
            .map_or(self.file_scope, |(_, scope)| *scope)
    }

    /// Every symbol `at` sees, innermost scope first, one per name: a
    /// declaration hoisted to its list's top (a function, a node, a type,
    /// a host unit) is seen from anywhere in it; any other binding from where
    /// it is written on.
    pub fn visible(&self, at: Loc) -> Vec<Visible<'_>> {
        let mut seen: Vec<Visible<'_>> = Vec::new();
        for scope in self.scopes.chain(self.scope_at(at)) {
            let mut here: Vec<Visible<'_>> = Vec::new();
            for id in self.scopes.scope(scope).declared.iter().copied() {
                let symbol = self.scopes.symbol(id);
                if !is_hoisted(symbol) && !before(symbol.span.start, at) {
                    continue;
                }
                if seen.iter().any(|v| v.symbol.name == symbol.name) {
                    continue;
                }
                match here.iter_mut().find(|v| v.symbol.name == symbol.name) {
                    Some(earlier) => *earlier = Visible { id, symbol },
                    None => here.push(Visible { id, symbol }),
                }
            }
            seen.extend(here);
        }
        seen
    }

    /// The symbol `name` is at `at`.
    pub fn resolve(&self, at: Loc, name: &str) -> Option<SymbolId> {
        if let Some(found) = self.visible(at).into_iter().find(|v| v.symbol.name == name) {
            return Some(found.id);
        }
        match self.scopes.resolve(self.scope_at(at), name) {
            Resolution::Found(id) => Some(id),
            _ => None,
        }
    }

    /// `resolve`, of what is bound above `at` alone: a binding further down
    /// the scope is one a walk written at `at` could not read.
    fn bound_above(&self, at: Loc, name: &str) -> Option<SymbolId> {
        self.resolve(at, name).filter(|id| {
            let symbol = self.scopes.symbol(*id);
            is_hoisted(symbol) || before(symbol.span.start, at)
        })
    }

    /// The checker's own typing of a walk's text, as written at a place in
    /// this file: it sees only the names bound above that place.
    pub fn type_walk(&self, query: WalkQuery<'_>) -> Result<WalkTyped, SlotError> {
        let WalkQuery { at, text, describing, zones } = query;
        let expr = expression_of_text(text)?;
        let env = EnvAt {
            analysis: self,
            at,
            scope: ScopeEnv {
                scopes: &self.scopes,
                scope: self.scope_at(at),
                zones,
                nodes: &self.nodes,
                upgrading_from: None,
                function_values: &self.function_values,
                entry_reads: &self.entry_reads,
            },
        };
        let span = Span { start: at, end: at };
        let mut typing = Typing::new(&env, span);
        typing.describing = describing;
        // A description traverses nothing, as an address does not.
        typing.address = describing;
        let ty = typing.infer(&expr);
        let landing = typing
            .walk_destination_of(&expr)
            .cloned()
            .or_else(|| typing.bare_name_of(&expr).and_then(|name| env.resolve_root(name)))
            .or_else(|| record_head_position(ty.as_ref()));
        let mut diagnostics = std::mem::take(&mut typing.diagnostics);
        let names = collect_expression_names(&expr);
        for name in names.distinct_refs().into_iter().filter(|name| !names.aliases.contains(*name) && !env.name_in_scope(name)) {
            // Typing leaves a name nothing binds to the check of the statement it is in.
            diagnostics.push(if self.resolve(at, name).is_some() {
                Diagnostic::error(codes::USE_BEFORE_BIND, read_before_binding(name), span)
            } else {
                Diagnostic::error(codes::NAME_UNRESOLVED, unknown_name(name), span)
            });
        }
        Ok(WalkTyped { landing, ty, diagnostics })
    }

    pub fn symbol(&self, id: SymbolId) -> &Symbol {
        self.scopes.symbol(id)
    }

    /// The record a symbol holds, where it holds one.
    pub fn position_of(&self, id: SymbolId) -> Option<&Position> {
        self.scopes.symbol(id).types.pos.as_ref()
    }

    /// The symbol's type in the author's words, where the check typed it.
    pub fn type_text(&self, id: SymbolId) -> Option<String> {
        let symbol = self.scopes.symbol(id);
        if let Some(pos) = &symbol.types.pos {
            return Some(describe_position(pos));
        }
        if let Some(closure) = self.function_values.get(&id) {
            return Some(describe_position(&Position::Closure(closure.clone())));
        }
        symbol.types.field.as_ref().or(symbol.types.may_hold.as_ref()).map(describe_field_type)
    }

    /// Where an imported name is declared in its library.
    pub fn imported(&self, local: &str) -> Option<&ImportedDeclaration> {
        self.imports.iter().find(|i| i.local == local)
    }
}
