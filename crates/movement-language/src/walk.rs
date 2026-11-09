//! The record a written receiver holds, as the check's own walk types it
//! (`Analysis::type_walk`): a name, a walk off one (`c-[m:Messages]->`), a
//! field holding a record (`c.Previous`), or a call or index giving one. The
//! cursor's line does not parse, so where the receiver's expression starts is
//! found by scanning back over the text; the checker types the rest.

use movement_checker::query::{WalkQuery, WalkTyped};
use movement_checker::types::field::{held_record_in, record_head_position};
use movement_checker::types::position::Position;
use movement_parser::ast::Loc;

use crate::Analyzed;
use crate::text::{is_word_char, trailing_word, written_name};

/// The record `text` (ending where the receiver ends) holds at `at`.
pub(crate) fn receiver(analyzed: &Analyzed, text: &str, at: Loc) -> Option<Position> {
    let written = closed_walk(analyzed, text.trim_end(), at, 0)?;
    let held = |text: &str| analyzed.analysis.type_walk(WalkQuery { at, text, describing: false, zones: analyzed.zones }).map(|typed| held_by(text, typed));
    match held(&written) {
        Ok(held) => held,
        // A hop's WHERE half written: the walk lands where it would without it.
        Err(_) => held(&without_clauses(&written)?).ok().flatten(),
    }
}

/// The record a typed text holds: where its walk lands, or, where it reads a
/// field off the landing last, the record that field's value holds.
fn held_by(text: &str, typed: WalkTyped) -> Option<Position> {
    if !reads_a_field(text) {
        return typed.landing;
    }
    let ty = typed.ty?;
    record_head_position(Some(&ty)).or_else(|| held_record_in(&ty).map(|held| held.position.clone()))
}

/// `text` ends reading a field: `c.Previous`, ``c?.`Previous Row` ``.
fn reads_a_field(text: &str) -> bool {
    let Some(name) = trailing_name(text) else { return false };
    let written = if text.ends_with('`') { name.len() + 2 } else { name.len() };
    text[..text.len() - written].strip_suffix('.').is_some_and(|receiver| !receiver.ends_with('.'))
}

/// The receiver's expression, as text the checker can type at `at`. A name
/// only an open hop above binds (`-[p:Team]-> { return p.`, `-[p:People
/// ORDER BY p-[:Company]->`) is not in the check's scope, the cursor's line
/// not parsing: that hop goes in front of it, closed.
fn closed_walk(analyzed: &Analyzed, text: &str, at: Loc, depth: usize) -> Option<String> {
    if depth > 16 {
        return None;
    }
    let start = expression_start(text)?;
    let written = text[start..].trim();
    let head = leading_name(written)?;
    if head.is_empty() || analyzed.analysis.resolve(at, &head).is_some() {
        return Some(written.to_string());
    }
    let Some(bound) = text[..start].rfind(&format!("-[{head}:")) else { return Some(written.to_string()) };
    let hop = match hop_close(&text[bound..]) {
        Some(close) => text[bound..bound + close].to_string(),
        None => format!("-[{head}:{}]->", written_name(&hop_edge(&text[bound + 2..])?)),
    };
    let before = text[..bound].trim_end();
    let closed = closed_walk(analyzed, before, at, depth + 1)?;
    let spelled = if written.starts_with('`') { head.len() + 2 } else { head.len() };
    Some(format!("{closed}{hop}{}", &written[spelled..]))
}

/// Where the expression `text` ends with starts: back over its hops, calls,
/// indexes and field reads to the name or bracket that heads them.
fn expression_start(text: &str) -> Option<usize> {
    let mut end = text.len();
    loop {
        let head = &text[..end];
        if let Some(hop) = head.strip_suffix("]->") {
            end = text[..hop_open(hop)?].trim_end().len();
            continue;
        }
        if let Some(inner) = head.strip_suffix(')') {
            end = matching_open(inner, '(', ')')?;
            if trailing_word(&text[..end]).is_empty() {
                return Some(end);
            }
            continue;
        }
        if let Some(inner) = head.strip_suffix(']') {
            end = matching_open(inner, '[', ']')?;
            continue;
        }
        let name = trailing_name(head)?;
        let written = if head.ends_with('`') { name.len() + 2 } else { name.len() };
        let before = &head[..head.len() - written];
        match before.strip_suffix('.') {
            // `...m` spreads `m`: no field read.
            Some(receiver) if !receiver.ends_with('.') => end = receiver.strip_suffix('?').unwrap_or(receiver).len(),
            _ => return Some(before.len()),
        }
    }
}

/// `walk` with each hop's clauses (its WHERE, its ORDER BY) left out, when it
/// has any: `c-[m:Messages WHERE m.Score >]->` → `c-[m:Messages]->`.
fn without_clauses(walk: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = walk;
    let mut cut = false;
    while let Some(open) = rest.find("-[") {
        let close = hop_close(&rest[open..])?;
        let hop = &rest[open + 2..open + close - 3];
        let edge = hop_edge(hop)?;
        let alias = hop.split_once(':').map(|(alias, _)| alias).filter(|alias| !alias.contains(|c: char| c.is_whitespace() || c == '`')).unwrap_or("");
        let bare = format!("-[{alias}:{}]->", written_name(&edge));
        cut |= bare.len() < close;
        out.push_str(&rest[..open]);
        out.push_str(&bare);
        rest = &rest[open + close..];
    }
    out.push_str(rest);
    cut.then_some(out)
}

/// Where the hop `text` opens (`-[`) is closed, past its `]->`.
fn hop_close(text: &str) -> Option<usize> {
    let mut depth = 0usize;
    for (at, c) in text.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return text[at + 1..].starts_with("->").then_some(at + 3);
                }
            }
            _ => {}
        }
    }
    None
}

/// Where `-[` opens the hop `head` (the text before its `]->`) closes.
fn hop_open(head: &str) -> Option<usize> {
    let open = matching_open(head, '[', ']')?;
    head[..open].ends_with('-').then(|| open - 1)
}

/// Where the bracket `head`'s end closes was opened.
fn matching_open(head: &str, open: char, close: char) -> Option<usize> {
    let mut depth = 1usize;
    for (at, c) in head.char_indices().rev() {
        if c == close {
            depth += 1;
        } else if c == open {
            depth -= 1;
            if depth == 0 {
                return Some(at);
            }
        }
    }
    None
}

/// The edge a hop's text (after its `-[`) names: `m:Messages WHERE …` → `Messages`.
pub fn hop_edge(hop: &str) -> Option<String> {
    let after = match hop.find(':') {
        Some(colon) if !hop[..colon].contains(|c: char| c.is_whitespace() || c == '`') => &hop[colon + 1..],
        _ => hop,
    };
    let after = after.trim_start();
    if let Some(rest) = after.strip_prefix('`') {
        return rest.find('`').map(|end| rest[..end].to_string());
    }
    let name: String = after.chars().take_while(|c| is_word_char(*c) || *c == '#' || *c == '@').collect();
    (!name.is_empty()).then_some(name)
}

/// The name `text` starts with: an identifier, or a backticked name.
fn leading_name(text: &str) -> Option<String> {
    if let Some(rest) = text.strip_prefix('`') {
        return rest.find('`').map(|end| rest[..end].to_string());
    }
    let word: String = text.chars().take_while(|c| is_word_char(*c)).collect();
    Some(word)
}

/// The name `text` ends with: an identifier, or a backticked name.
pub fn trailing_name(text: &str) -> Option<String> {
    if let Some(head) = text.strip_suffix('`') {
        return head.rfind('`').map(|open| head[open + 1..].to_string());
    }
    let word = trailing_word(text);
    (!word.is_empty()).then(|| word.to_string())
}
