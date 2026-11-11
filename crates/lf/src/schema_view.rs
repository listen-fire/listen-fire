//! A connection's schema written out from the description value
//! (movement_checker::description), one notation for `listen-fire catalog`,
//! its address and `listen-fire modules show`. What a field's marks are and
//! what an edge can do are the value's; here is only how they are written.

use std::rc::Rc;

use movement_checker::description::{DescribedEdge, DescribedField, Description, FieldList, Known, Mark, Showing, connection_root, describe_landing, described_record_types, landing_name};
pub(crate) use movement_checker::description::LEGEND;
use movement_checker::types::position::Position;
use movement_parser::catalog::types::{InstanceSchema, read_catalog};
use movement_parser::catalog::written_type::WrittenType;
use movement_parser::util::form::read_json_text;

use crate::json::{Js, Obj};
use crate::modules::first_sentence;
use crate::obj;

/// What a described schema offers a program: the edges a walk, a write or a
/// listen starts from, and the record types.
#[derive(Default)]
pub(crate) struct SchemaView {
    edges: Vec<DescribedEdge>,
    records: Vec<RecordType>,
}

struct RecordType {
    name: String,
    described: Description,
}

impl SchemaView {
    /// The view of a described schema (`InstanceSchema`, docs/contracts/catalog-snapshot.md).
    pub(crate) fn of(connection: &str, schema: &Js) -> Result<SchemaView, String> {
        let json = schema.to_json();
        let schema: InstanceSchema = read_catalog(&read_json_text(&json))?;
        let root = connection_root(connection, Rc::new(schema));
        Ok(SchemaView {
            edges: describe_landing(&root, Showing::default()).edges,
            records: described_record_types(&root).into_iter().map(|(name, landing)| RecordType { name, described: describe_landing(&landing, Showing::default()) }).collect(),
        })
    }

    pub(crate) fn read_only(&self) -> bool {
        !self.edges.iter().chain(self.records.iter().flat_map(|record| &record.described.edges)).any(|edge| edge.can.write)
    }

    /// Where a walk or a listen starts: `-[:Ticks]-> Tick [fires]`.
    pub(crate) fn starts(&self) -> Vec<String> {
        self.edges.iter().map(DescribedEdge::hop).collect()
    }

    /// Each record type in one line, its fields then its edges:
    /// `Tick: `Fired At` date, Schedule Cron`.
    pub(crate) fn record_summaries(&self) -> Vec<String> {
        self.records
            .iter()
            .map(|record| {
                let parts: Vec<String> = read_fields(&record.described.fields).map(DescribedField::written).chain(record.described.edges.iter().map(DescribedEdge::hop)).collect();
                format!("{}: {}", record.name, if parts.is_empty() { "(no fields)".into() } else { parts.join(", ") })
            })
            .collect()
    }

    /// Where a walk or a listen starts and the record types, a blank line before each.
    pub(crate) fn lines(&self, out: &mut Vec<String>) {
        if !self.edges.is_empty() {
            out.push(String::new());
            out.push("start a walk, a write or a listen from the connection with:".into());
            out.extend(self.edges.iter().map(|edge| format!("  {}", edge_text(edge))));
        }
        if self.records.is_empty() {
            return;
        }
        out.push(String::new());
        let pinned = |record: &RecordType| read_fields(&record.described.fields).any(|field| field.pinned);
        out.push(if self.records.iter().any(pinned) { "record types (pinned: the fields a read's WHERE must set with ==):".into() } else { "record types:".into() });
        for record in &self.records {
            let described = &record.described;
            out.push(format!("  {}{}", record.name, described.description.as_deref().map(|d| format!(": {}", first_sentence(d))).unwrap_or_default()));
            let mut fields: Vec<String> = read_fields(&described.fields).map(DescribedField::written).collect();
            if described.known == Known::Open {
                fields.push("… (others its module does not name)".into());
            }
            if !fields.is_empty() {
                out.push(format!("    fields: {}", fields.join(", ")));
            }
            let pinned = pinned_names(&described.fields);
            if !pinned.is_empty() {
                out.push(format!("    pinned: {}", pinned.join(", ")));
            }
            let reads: Vec<String> = described.edges.iter().filter(|edge| !edge.can.write).map(DescribedEdge::hop).collect();
            if !reads.is_empty() {
                out.push(format!("    edges: {}", reads.join(", ")));
            }
            out.extend(described.edges.iter().filter(|edge| edge.can.write).map(|edge| format!("    {}", edge_text(edge))));
        }
    }

    /// `modules show --json`'s members.
    pub(crate) fn to_json(&self) -> Obj {
        let edge = |e: &DescribedEdge| {
            obj! {
                "name" => Js::str(&e.name),
                "target" => Js::str(e.target_name()),
                "readable" => Js::Bool(e.can.read),
                "listenable" => Js::Bool(e.can.fires),
            }
        };
        let collection = |e: &DescribedEdge| {
            let mut collection = edge(e);
            if let Some(description) = &e.description {
                collection.insert("description".into(), Js::str(description));
            }
            Js::Obj(collection)
        };
        let write = |along: String, e: &DescribedEdge| {
            let fields = e.write_fields.iter().flat_map(|list| &list.shown);
            Js::Obj(obj! {
                "along" => Js::str(along),
                "target" => Js::str(e.target_name()),
                "fields" => Js::Arr(fields.map(|f| Js::Obj(obj! { "name" => Js::str(&f.name), "required" => Js::Bool(f.marks.contains(&Mark::Required)) })).collect()),
            })
        };
        let root_writes = self.edges.iter().filter(|e| e.can.write).map(|e| write(format!("the connection's {}", e.name), e));
        let record_writes = self.records.iter().flat_map(|record| {
            record.described.edges.iter().filter(|e| e.can.write).map(|e| write(format!("{}.{}{}", record.name, e.name, if e.can.read { "" } else { ", write only" }), e))
        });
        obj! {
            "collections" => Js::Arr(self.edges.iter().map(collection).collect()),
            "records" => Js::Arr(self.records.iter().map(|record| Js::Obj(obj! {
                "name" => Js::str(&record.name),
                "description" => record.described.description.as_deref().map_or(Js::Null, Js::str),
                "fields" => Js::Arr(read_fields(&record.described.fields).map(|f| Js::Obj(obj! { "name" => Js::str(&f.name), "type" => Js::str(&f.type_) })).collect()),
                "pinned" => Js::strings(read_fields(&record.described.fields).filter(|f| f.pinned).map(|f| &f.name)),
                "edges" => Js::Arr(record.described.edges.iter().filter(|e| e.can.read || e.can.fires).map(|e| Js::Obj(edge(e))).collect()),
            })).collect()),
            "writes" => Js::Arr(root_writes.chain(record_writes).collect()),
        }
    }
}

/// One place: what lands there in full, then each edge leaving it with what
/// lands at its end, one level deep. `address` is what reaches it.
pub(crate) fn place_text(address: &str, landing: &Position) -> String {
    let described = describe_landing(landing, Showing::default());
    let mut out = vec![LEGEND.to_string(), format!("place: {}", shell_quoted(address)), landing_name(landing)];
    what_it_is(&described, "", &mut out);
    match described.known {
        Known::Undescribed => out.push("fields: not described".into()),
        Known::Whole if described.fields.shown.is_empty() => out.push("fields: none".into()),
        Known::Whole | Known::Open => {
            out.push("fields:".into());
            fields_of(&described, "  ", &mut out);
        }
    }
    out.push(if described.edges.is_empty() { "edges: none".into() } else { "edges:".into() });
    for edge in &described.edges {
        out.push(format!("  {}", edge_text(edge)));
        out.extend(edge.description.iter().map(|d| format!("    {d}")));
        let Some(landing) = &edge.landing else {
            out.push("    where it lands is not described".into());
            continue;
        };
        let target = describe_landing(landing, Showing::default());
        // A type known only by what is written to it says what its root edge says.
        let repeats = target.description == edge.description;
        let told = Description { description: target.description.clone().filter(|_| !repeats), ..target.clone() };
        what_it_is(&told, "    ", &mut out);
        match target.known {
            Known::Undescribed => out.push("    its fields are not described".into()),
            Known::Whole | Known::Open => fields_of(&target, "    ", &mut out),
        }
    }
    out.join("\n")
}

/// The module's words for what lands, and what it may be.
fn what_it_is(described: &Description, indent: &str, out: &mut Vec<String>) {
    out.extend(described.description.iter().map(|d| format!("{indent}{d}")));
    if !described.members.is_empty() {
        out.push(format!("{indent}may be: {}", described.members.join(", ")));
    }
}

fn fields_of(described: &Description, indent: &str, out: &mut Vec<String>) {
    out.extend(described.fields.shown.iter().map(|field| {
        let words = field.description.as_deref().map(|d| format!(": {d}")).unwrap_or_default();
        format!("{indent}{}{words}", field.written_noted())
    }));
    if described.known == Known::Open {
        out.push(format!("{indent}… (others its module does not name)"));
    }
    let pinned = pinned_names(&described.fields);
    if !pinned.is_empty() {
        out.push(format!("{indent}pinned (a read's WHERE must set each with ==): {}", pinned.join(", ")));
    }
}

/// The fields a read has: a field only written is said on the edge it is written along.
fn read_fields(fields: &FieldList) -> impl Iterator<Item = &DescribedField> {
    fields.shown.iter().filter(|field| !field.write_only)
}

fn pinned_names(fields: &FieldList) -> Vec<String> {
    read_fields(fields).filter(|field| field.pinned).map(|field| spelled_name(&field.name)).collect()
}

fn spelled_name(name: &str) -> String {
    WrittenType::name(name).spell()
}

/// The hop, then what a write along it takes.
fn edge_text(edge: &DescribedEdge) -> String {
    if !edge.can.write {
        return edge.hop();
    }
    let fields: Vec<String> = edge.write_fields.iter().flat_map(|list| &list.shown).map(DescribedField::marked_name).collect();
    format!("{}: {}", edge.hop(), if fields.is_empty() { "(no fields)".to_string() } else { fields.join(", ") })
}

/// In single quotes, as anything printed is: in double quotes a shell runs a
/// backticked edge name as a command.
fn shell_quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(schema: &str) -> Vec<String> {
        let mut out = Vec::new();
        SchemaView::of("c", &Js::parse(schema.as_bytes()).unwrap()).unwrap().lines(&mut out);
        out
    }

    #[test]
    fn a_write_only_edge_lists_what_it_can_do_and_what_a_write_takes_on_its_own_line() {
        let out = lines_of(
            r#"{"positions":{"Message":{"properties":{"Id":"text","Text":"text","Sent At":"date"},"edges":{
                  "Replies":{"target":"Message","readable":false,"writable":true},
                  "Linked Users":{"target":"Linked User"},
                  "Reactions":{"target":"Reaction","readable":false,"listenable":true},
                  "Thread":{"target":"Message","listenable":true}}},
                "Linked User":{"properties":{},"edges":{}},
                "Reaction":{"properties":{"Tags":{"kind":"list","of":{"kind":"enum","options":["a","b"]}}},"edges":{},"openProperties":true},
                "Vague":{"undescribed":true,"properties":{},"edges":{}}},
              "collections":{"Messages":{"target":"Message","readable":false,"listenable":true},"Send":{"target":"Message"}},
              "writableRoots":{"Message":{"fields":{"Text":"text","Reply Markup":"json"},"requiredFields":["Text"],"nativeUniqueness":[["Id"]],"resultShape":{}}}}"#,
        );
        assert_eq!(
            out,
            [
                "",
                "start a walk, a write or a listen from the connection with:",
                "  -[:Messages]-> Message [w fires]: Text!, `Reply Markup`",
                "  -[:Send]-> Message [r w]: Text!, `Reply Markup`",
                "",
                "record types:",
                "  Message",
                "    fields: Text! text, Id*~ text, `Sent At`~ date",
                "    edges: -[:`Linked Users`]-> Linked User, -[:Reactions]-> Reaction [fires], -[:Thread]-> Message [r fires]",
                "    -[:Replies]-> Message [w]: Text!, `Reply Markup`",
                "  Linked User",
                "  Reaction",
                r#"    fields: Tags ("a" | "b")[], … (others its module does not name)"#,
            ]
        );
    }
}
