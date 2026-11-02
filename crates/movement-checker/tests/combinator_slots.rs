//! What a combinator's slot and a collection op's member are typed as.
//!
//! A slot holds what its arm returned, a record as well as a value, so a
//! read off it is checked against that record's fields.
//!
//! A record a run awaits can be deleted while it waits, and the wait then
//! never ends: nothing after it runs. So an arm or a member that awaits
//! answers what it returns, present, as any other does; only an `all` whose
//! `onError` lets a failed arm through leaves a slot maybe absent.
//!
//! Every rule is checked on two catalog shapes: mail to a CRM's person, and
//! a chat post about a desk's ticket.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const MAIL: &str = r#"{"adapters":{
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Email":"text","Name":"text"},"edges":{}}},
    "collections":{"People":{"target":"Person"}},"writableRoots":{}}}},
  "mail":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Message":{"properties":{"To":"text","Title":"text","From":"text","Sent":"text"},"edges":{
      "Replies":{"target":"Message","listenable":true,"sequenced":"chronological","identity":"Sent"}}}},
    "collections":{"Messages":{"target":"Message"}},
    "writableRoots":{"Message":{"fields":{"To":"text"},"resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

const CHAT: &str = r#"{"adapters":{
  "desk":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Ticket":{"properties":{"Owner":"text","Subject":"text"},"edges":{}}},
    "collections":{"Tickets":{"target":"Ticket"}},"writableRoots":{}}}},
  "chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Post":{"properties":{"Text":"text","Author":"text","Ts":"text"},"edges":{
      "Replies":{"target":"Post","listenable":true,"identity":"Ts"}}}},
    "collections":{"Posts":{"target":"Post"}},
    "writableRoots":{"Post":{"fields":{"Text":"text"},"resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

/// One catalog shape, as the program spells it: what is written, the field
/// a write needs, the field read off a reply, and the edge awaited.
struct Shape {
    catalog: &'static str,
    header: &'static str,
    /// The writable collection, spelled `system-[:Collection]->`.
    collection: &'static str,
    /// The field the write needs (a text).
    needs: &'static str,
    /// A text field read off a reply.
    read: &'static str,
    /// The type written, as the messages name it.
    named: &'static str,
    /// How a reply is awaited: the chat's replies have no order, so only
    /// one that arrives is awaited.
    awaits: &'static str,
}

const SHAPES: [Shape; 2] = [
    Shape {
        catalog: MAIL,
        header: "import { crm as crm_module, mail as mail_module } from adapters; crm = connect crm_module; mail = connect mail_module;",
        collection: "mail-[:Messages]->",
        needs: "To",
        read: "From",
        named: "mail.Message",
        awaits: "await",
    },
    Shape {
        catalog: CHAT,
        header: "import { desk as desk_module, chat as chat_module } from adapters; desk = connect desk_module; chat = connect chat_module;",
        collection: "chat-[:Posts]->",
        needs: "Text",
        read: "Author",
        named: "chat.Post",
        awaits: "await new",
    },
];

/// Every diagnostic on `program` (after the shape's header, on line 1), with
/// `$C`, `$N`, `$R` and `$W` spelled as the shape's collection, needed
/// field, read field and await.
fn found(shape: &Shape, program: &str) -> Vec<String> {
    let program = program.replace("$C", shape.collection).replace("$N", shape.needs).replace("$R", shape.read).replace("$W", shape.awaits);
    let source = format!("{}\n{program}", shape.header);
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(shape.catalog).unwrap(), options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.code != "MOV_LISTEN_MISSING")
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

#[test]
fn an_all_arm_that_awaits_fills_its_slot() {
    let program = "function go(t: <text>) {\n  m = write $C { $N: t }\n  r = all(() => {\n    x = $W m-[:Replies]->\n    write $C { $N: x.$R }\n    return x.$R\n  }, () => \"b\")\n  write $C { $N: r[0] }\n  write $C { $N: r[1] }\n}\n";
    for shape in &SHAPES {
        assert_eq!(found(shape, program), Vec::<String>::new(), "{}", shape.named);
    }
}

#[test]
fn an_arm_named_by_a_closure_or_a_movement_that_awaits_fills_its_slot() {
    let closure = "function go(t: <text>) {\n  m = write $C { $N: t }\n  f = () => {\n    x = $W m-[:Replies]->\n    return x.$R\n  }\n  r = all(f, () => \"b\")\n  write $C { $N: r[0] }\n}\n";
    let movement = "function wait_for(): <text> {\n  m = write $C { $N: \"x\" }\n  x = $W m-[:Replies]->\n  return x.$R\n}\nfunction go(t: <text>) {\n  r = all(wait_for, () => \"b\")\n  write $C { $N: r[0] }\n}\n";
    for shape in &SHAPES {
        assert_eq!(found(shape, closure), Vec::<String>::new(), "{}", shape.named);
        assert_eq!(found(shape, movement), Vec::<String>::new(), "{}", shape.named);
    }
}

#[test]
fn an_all_that_lets_a_failed_arm_through_leaves_its_slot_maybe_absent() {
    let program = "function go(t: <text>) {\n  m = write $C { $N: t }\n  r = all(() => {\n    x = $W m-[:Replies]->\n    return x.$R\n  }, () => \"b\", { onError: \"warn\" })\n  write $C { $N: r[0] }\n}\n";
    for shape in &SHAPES {
        let (needs, named) = (shape.needs, shape.named);
        let col = 14 + shape.collection.len() + needs.len();
        let end = col + "r[0]".len();
        let absent = format!(
            "MOV_ABSENT_REQUIRED 8:{col}-8:{end} '{needs}' on {named} needs a value, but 'r[0]' may be absent (text (or absent)) — write '{needs}: coalesce(r[0], \"unknown\")' to fall back to a value that is always there, or '{needs} ?: r[0]' to leave it unset when absent (see handbook: front#maybe-absent)"
        );
        assert_eq!(found(shape, program), [absent], "{named}");
    }
}

#[test]
fn a_map_or_reduce_member_that_awaits_answers_present() {
    let map = "function go(t: <text>) {\n  ms = List.from($C)\n  xs = map(ms, (m) => {\n    x = $W m-[:Replies]->\n    return x.$R\n  })\n  ys = map(xs, (x: <text>) => Text.upper(x))\n}\n";
    let reduce = "function go(t: <text>) {\n  m = write $C { $N: t }\n  ms = List.from(m-[:Replies]->)\n  n = reduce(ms, (a, p) => {\n    x = $W p-[:Replies]->\n    return x.$R\n  }, \"\")\n  write $C { $N: n }\n}\n";
    for shape in &SHAPES {
        assert_eq!(found(shape, map), Vec::<String>::new(), "{}", shape.named);
        let reduced: Vec<String> = found(shape, reduce).into_iter().filter(|d| !d.starts_with("MOV_FOLD_NEEDS_ORDER")).collect();
        assert_eq!(reduced, Vec::<String>::new(), "{}", shape.named);
    }
}

#[test]
fn a_slot_keeps_the_record_its_arm_returns() {
    let race = "function go(t: <text>) {\n  m = write $C { $N: t }\n  r = race(() => {\n    return $W m-[:Replies]->\n  }, () => { await sleep(1d) })\n  if (r[0] != null) {\n    write $C { $N: coalesce(r[0].$R, \"none\") }\n    write $C { $N: coalesce(r[0].Nonexistent, \"none\") }\n  }\n}\n";
    let all = "function go(t: <text>) {\n  m = write $C { $N: t }\n  r = all(() => {\n    return only(m-[:Replies]->)\n  })\n  write $C { $N: coalesce(r[0]?.$R, \"none\") }\n  write $C { $N: coalesce(r[0]?.Nonexistent, \"none\") }\n}\n";
    for shape in &SHAPES {
        let unknown = |line: usize, indent: usize, read: &str| {
            let col = indent + 12 + shape.collection.len() + shape.needs.len();
            let fields = if shape.catalog == MAIL { "To, Title, From, Sent" } else { "Text, Author, Ts" };
            format!(
                "MOV_UNKNOWN_PROPERTY {line}:{col}-{line}:{} {} has no field 'Nonexistent' — it has: {fields}; and edges, walked (`-[:…]->`) rather than read: Replies",
                col + format!("coalesce({read}, \"none\")").len(),
                shape.named
            )
        };
        assert_eq!(found(shape, race), [unknown(9, 4, "r[0].Nonexistent")], "{}", shape.named);
        assert_eq!(found(shape, all), [unknown(8, 2, "r[0]?.Nonexistent")], "{}", shape.named);
    }
}
