//! `listen-fire example <words…>`: a few lines of listen-fire doing what the
//! words ask, for an author unsure how to write it. With no words, every
//! example's intent, one a line.
//!
//! The examples are `data/examples.md`, which the handbook package reads too
//! (packages/handbook/micro_examples.ts): its tests check every snippet, and
//! the authoring tools search them by the same rule as here. The rule is the
//! language search's (shared words, the intent and search line weighing three,
//! the snippet and note one), ported because this binary carries no
//! TypeScript; apps/cli's micro_examples test drives this command against the
//! handbook's answer for every query in the quality table, so the two cannot
//! drift.

use std::collections::BTreeSet;
use std::io::Write;

const EXAMPLES: &str = include_str!("../data/examples.md");

/// The most examples one lookup prints.
const MAX_EXAMPLES: usize = 3;

pub struct Example {
    /// What the handbook's quality table names it by; a lookup never shows it.
    #[cfg_attr(not(test), allow(dead_code))]
    id: String,
    intent: String,
    search: String,
    code: String,
    note: Option<String>,
}

/// The examples in `text`, in the order written: each `### id` section's
/// intent line, `search:` line, one fenced snippet and the note after it.
fn parse(text: &str) -> Vec<Example> {
    let mut sections: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in text.split('\n') {
        match line.strip_prefix("### ") {
            Some(heading) => sections.push((heading, Vec::new())),
            None => {
                if let Some((_, lines)) = sections.last_mut() {
                    lines.push(line);
                }
            }
        }
    }
    sections
        .into_iter()
        .map(|(heading, lines)| {
            let id = heading.trim().to_string();
            let fence_at = lines.iter().position(|line| line.starts_with("```")).unwrap_or_else(|| panic!("micro example {id}: no fenced snippet"));
            let fence_end = fence_at + 1 + lines[fence_at + 1..].iter().position(|line| line.starts_with("```")).unwrap_or_else(|| panic!("micro example {id}: the snippet is never closed"));
            let before: Vec<&str> = lines[..fence_at].iter().map(|line| line.trim()).filter(|line| !line.is_empty()).collect();
            let search = before.iter().find_map(|line| line.strip_prefix("search:")).map(str::trim).unwrap_or("").to_string();
            let intent = before.iter().find(|line| !line.starts_with("search:")).unwrap_or_else(|| panic!("micro example {id}: no intent line")).to_string();
            let note = lines[fence_end + 1..].iter().map(|line| line.trim()).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" ");
            Example { id, intent, search, code: lines[fence_at + 1..fence_end].join("\n"), note: (!note.is_empty()).then_some(note) }
        })
        .collect()
}

pub fn examples() -> Vec<Example> {
    parse(EXAMPLES)
}

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "to", "of", "or", "and", "in", "on", "for", "with", "by", "is", "it", "its", "from", "into", "as", "at", "be", "i", "how", "do", "does", "what", "my", "me", "this", "that", "when",
    "each", "can", "get", "use", "using", "want",
];

/// A word reduced to a rough stem, so "records", "recorded" and "record" meet.
fn stem(word: &str) -> &str {
    let cut = ["ing", "ed", "es", "s", "e"].iter().find_map(|suffix| word.strip_suffix(suffix)).unwrap_or(word);
    if cut.len() >= 3 { cut } else { word }
}

/// The words of `text` as a search compares them: camelCase split, lower-cased,
/// stop words dropped, each stemmed.
fn tokens(text: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(text.len());
    let mut previous: Option<char> = None;
    for c in text.chars() {
        if c.is_ascii_uppercase() && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit()) {
            spaced.push(' ');
        }
        spaced.push(c);
        previous = Some(c);
    }
    spaced
        .to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|word| !word.is_empty() && !STOPWORDS.contains(word))
        .map(|word| stem(word).to_string())
        .collect()
}

fn score(wanted: &BTreeSet<String>, example: &Example) -> usize {
    let asked: BTreeSet<String> = tokens(&format!("{} {}", example.intent, example.search)).into_iter().collect();
    let shown: BTreeSet<String> = tokens(&format!("{} {}", example.code, example.note.as_deref().unwrap_or(""))).into_iter().collect();
    wanted.iter().map(|word| if asked.contains(word) { 3 } else { 0 } + if shown.contains(word) { 1 } else { 0 }).sum()
}

/// The best few examples for `query`; only those scoring at least half the best one's.
pub fn search<'a>(query: &str, examples: &'a [Example]) -> Vec<&'a Example> {
    let wanted: BTreeSet<String> = tokens(query).into_iter().collect();
    let mut scored: Vec<(usize, &Example)> = examples.iter().map(|example| (score(&wanted, example), example)).filter(|(score, _)| *score > 0).collect();
    // Stable: equal scores keep the order the examples are written in.
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let best = scored.first().map_or(0, |(score, _)| *score);
    scored.into_iter().filter(|(score, _)| score * 2 >= best).take(MAX_EXAMPLES).map(|(_, example)| example).collect()
}

fn render_one(example: &Example) -> String {
    let mut text = format!("# {}\n{}", example.intent, example.code);
    if let Some(note) = &example.note {
        text.push_str(&format!("\n# {note}"));
    }
    text
}

/// What a lookup prints: the examples one after another, or what to try when none matched.
pub fn render(query: &str, found: &[&Example]) -> String {
    if found.is_empty() {
        return format!(
            "No example matches \"{query}\". Ask in other words (\"create or update\", \"run every Monday\", \"value that may be missing\"), or with none to list every example."
        );
    }
    found.iter().map(|example| render_one(example)).collect::<Vec<_>>().join("\n\n")
}

pub fn run(words: &[String], out: &mut impl Write) -> Result<i32, String> {
    let all = examples();
    if words.is_empty() {
        writeln!(out, "listen-fire example <words…> shows a few checked lines doing what the words ask. Every example:").map_err(|e| e.to_string())?;
        for example in &all {
            writeln!(out, "  {}", example.intent).map_err(|e| e.to_string())?;
        }
        return Ok(0);
    }
    let query = words.join(" ");
    let found = search(&query, &all);
    writeln!(out, "{}", render(&query, &found)).map_err(|e| e.to_string())?;
    Ok(if found.is_empty() { 1 } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_example_reads_and_ids_are_distinct() {
        let all = examples();
        assert!(all.len() >= 30, "{} examples", all.len());
        let ids: BTreeSet<&str> = all.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids.len(), all.len());
        for example in &all {
            assert!(!example.intent.is_empty() && !example.code.is_empty(), "{}", example.id);
        }
    }

    /// The handbook's quality table: the same queries, the same first answer.
    #[test]
    fn the_quality_table_answers_first_what_it_names() {
        let table: serde_json::Value = serde_json::from_str(include_str!("../../../packages/handbook/__test__/example_queries.json")).unwrap();
        let all = examples();
        let misses: Vec<String> = table["queries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| {
                let (query, top) = (row["query"].as_str().unwrap(), row["top"].as_str().unwrap());
                let got: Vec<&str> = search(query, &all).iter().map(|e| e.id.as_str()).collect();
                (got.first() != Some(&top)).then(|| format!("{query:?} -> {got:?}, want {top}"))
            })
            .collect();
        assert!(misses.is_empty(), "{misses:#?}");
    }

    #[test]
    fn stems_and_splits_as_the_language_search_does() {
        // What packages/handbook's searchTokens answers for the same text.
        assert_eq!(tokens("unique byDistinct Records"), vec!["uniqu", "distinct", "record"]);
        assert_eq!(tokens("today's date"), vec!["today", "s", "dat"]);
        assert_eq!(tokens("uses sing listening a1B aBcD"), vec!["uses", "sing", "listen", "a1", "b", "bc", "d"]);
    }

    #[test]
    fn nothing_matched_says_what_to_try() {
        let all = examples();
        assert!(search("zzzz qqqq", &all).is_empty());
        assert!(render("zzzz", &[]).starts_with("No example matches \"zzzz\""));
    }
}
