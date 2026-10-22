//! Built-ins as the language spells them: the spelling table's current
//! names, with each one's signature from the standard library's and what it
//! does from the built-ins reference (`builtins.md`, which the platform's
//! handbook serves as its builtins chapter, so the two cannot drift).

use movement_checker::types::stdlib::{Builtin, ParamType, lookup_builtin};
use movement_parser::surface::table::{CORE_WORDS, NAMESPACES, SPELLINGS, Shape, Spelling, by_current};

/// One built-in a program calls.
pub struct CurrentBuiltin {
    pub name: &'static str,
    pub spelling: &'static Spelling,
}

/// Every built-in a program calls by name (operators and indexing left out).
pub fn current_builtins() -> Vec<CurrentBuiltin> {
    let mut out: Vec<CurrentBuiltin> = Vec::new();
    for spelling in SPELLINGS.iter().filter(|s| !s.old_only) {
        let name = spelling.current;
        if !name.chars().all(|c| c.is_alphanumeric() || c == '.') || out.iter().any(|b| b.name == name) {
            continue;
        }
        out.push(CurrentBuiltin { name, spelling });
    }
    out
}

/// The core words the grammar reads that are not in the table (`sleep`, `race`, …).
pub fn grammar_words() -> impl Iterator<Item = &'static str> {
    CORE_WORDS.iter().copied().filter(|w| !SPELLINGS.iter().any(|s| s.current == *w))
}

pub fn namespaces() -> &'static [&'static str] {
    NAMESPACES
}

/// The built-in written `name` in the current language.
pub fn by_name(name: &str) -> Option<CurrentBuiltin> {
    by_current(name).map(|spelling| CurrentBuiltin { name: spelling.current, spelling })
}

fn param_text(param: &movement_checker::types::stdlib::Param) -> String {
    use movement_checker::types::stdlib::Arity;
    match param.arity {
        Arity::One => param.name.to_string(),
        Arity::Optional => format!("{}?", param.name),
        Arity::Rest => format!("…{}", param.name),
    }
}

impl CurrentBuiltin {
    fn library(&self) -> Option<&'static Builtin> {
        lookup_builtin(self.spelling.canonical)
    }

    /// `Text.upper(text)`, its parameters in the order the language writes them.
    pub fn signature(&self) -> String {
        let Some(builtin) = self.library() else { return format!("{}(…)", self.name) };
        let mut params: Vec<String> = builtin.params.iter().map(param_text).collect();
        match self.spelling.shape {
            Shape::SettingsLast => {
                if let Some(at) = builtin.params.iter().position(|p| p.ty == ParamType::Options) {
                    let settings = params.remove(at);
                    params.push(settings);
                }
            }
            Shape::ReduceOrder if params.len() >= 3 => params.swap(1, 2),
            _ => {}
        }
        format!("{}({})", self.name, params.join(", "))
    }

    /// What it does: the reference's paragraph under its heading, else what it
    /// returns (nothing when that depends on its arguments).
    pub fn doc(&self) -> Option<String> {
        use movement_checker::types::stdlib::Returns;
        if let Some(line) = reference_line(self.name) {
            return Some(line.to_string());
        }
        let returns = match self.library()?.returns {
            Returns::Text => "Returns text.",
            Returns::Number => "Returns a number.",
            Returns::Boolean => "Returns true or false.",
            Returns::Date => "Returns a date.",
            Returns::Datetime => "Returns a date and time.",
            Returns::File => "Returns a file.",
            Returns::ListOfText => "Returns a list of text.",
            Returns::MaybeAbsentText => "Returns text, or null.",
            Returns::MaybeAbsentDate => "Returns a date, or null.",
            Returns::Never => "Fails the run here.",
            Returns::Derived => return None,
        };
        Some(returns.to_string())
    }
}

const REFERENCE: &str = include_str!("builtins.md");

/// The paragraph under the reference's `### name` heading: the signature, what
/// it gives back and what it does, in one line.
pub fn reference_line(name: &str) -> Option<&'static str> {
    let heading = format!("\n### {name}\n");
    let body = &REFERENCE[REFERENCE.find(&heading)? + heading.len()..];
    body.trim_start_matches('\n').split("\n\n").next().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#'))
}

#[cfg(test)]
mod tests {
    /// A heading renamed in the reference would quietly drop a built-in's
    /// card back to what it returns. `fail` and `callback` are explained in
    /// other chapters (`crate::docs::builtin_page`).
    #[test]
    fn every_built_in_has_a_line_in_the_reference() {
        let missing: Vec<&str> = super::current_builtins().iter().map(|b| b.name).filter(|name| super::reference_line(name).is_none()).collect();
        assert_eq!(missing, vec!["fail", "callback"]);
    }
}
