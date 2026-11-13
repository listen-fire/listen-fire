//! JSON with every object's keys sorted, written straight from a `Serialize`
//! value. The bytes are the ones `serde_json::to_value` then `to_vec` writes
//! (a `Value`'s map is a `BTreeMap`), without building the `Value` between.
//!
//! An object's entries are written where they fall, and each one's key is
//! kept beside the range it took. An object whose keys did not arrive in
//! order (a struct's come in declaration order) is rewritten sorted when it
//! ends; of two equal keys the later value is kept, as the `Value`'s map
//! insert keeps it. Every other value is written as the `Value` it would
//! have become, so numbers, escapes and refusals are serde_json's own.

use std::borrow::Cow;
use std::ops::Range;

use serde::Serialize;
use serde::ser::{self, Error as _, Impossible, SerializeMap as _, Serializer as _};
use serde_json::{Error, Value};

/// `value`'s JSON appended to `out`, every object's keys sorted.
pub fn write<T: ?Sized + Serialize>(value: &T, out: &mut Vec<u8>) -> Result<(), Error> {
    value.serialize(Writer { out })
}

/// The name serde_json's `RawValue` serialises under (its own `raw::TOKEN`,
/// which it does not export). The `Value` path parses a raw value's text, so
/// the text is written as the `Value` it reads as: sorted, its spacing gone.
const RAW_VALUE: &str = "$serde_json::private::RawValue";

struct Writer<'a> {
    out: &'a mut Vec<u8>,
}

impl Writer<'_> {
    fn value(self, value: Result<Value, Error>) -> Result<(), Error> {
        serde_json::to_writer(&mut *self.out, &value?)
    }

    /// A text, written as a `Value::String` is.
    fn text(self, text: &str) -> Result<(), Error> {
        serde_json::to_writer(&mut *self.out, text)
    }
}

impl<'a> ser::Serializer for Writer<'a> {
    type Ok = ();
    type Error = Error;
    type SerializeSeq = Seq<'a>;
    type SerializeTuple = Seq<'a>;
    type SerializeTupleStruct = Seq<'a>;
    type SerializeTupleVariant = Seq<'a>;
    type SerializeMap = Object<'a>;
    type SerializeStruct = Struct<'a>;
    type SerializeStructVariant = Object<'a>;

    fn serialize_bool(self, v: bool) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_bool(v))
    }
    fn serialize_i8(self, v: i8) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_i8(v))
    }
    fn serialize_i16(self, v: i16) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_i16(v))
    }
    fn serialize_i32(self, v: i32) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_i32(v))
    }
    fn serialize_i64(self, v: i64) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_i64(v))
    }
    fn serialize_i128(self, v: i128) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_i128(v))
    }
    fn serialize_u8(self, v: u8) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_u8(v))
    }
    fn serialize_u16(self, v: u16) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_u16(v))
    }
    fn serialize_u32(self, v: u32) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_u32(v))
    }
    fn serialize_u64(self, v: u64) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_u64(v))
    }
    fn serialize_u128(self, v: u128) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_u128(v))
    }
    fn serialize_f32(self, v: f32) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_f32(v))
    }
    fn serialize_f64(self, v: f64) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_f64(v))
    }
    fn serialize_char(self, v: char) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_char(v))
    }
    fn serialize_str(self, v: &str) -> Result<(), Error> {
        self.text(v)
    }
    fn serialize_bytes(self, v: &[u8]) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_bytes(v))
    }
    fn serialize_none(self) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_none())
    }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<(), Error> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<(), Error> {
        self.value(serde_json::value::Serializer.serialize_unit())
    }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<(), Error> {
        self.serialize_unit()
    }
    fn serialize_unit_variant(self, _name: &'static str, _index: u32, variant: &'static str) -> Result<(), Error> {
        self.text(variant)
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(self, _name: &'static str, value: &T) -> Result<(), Error> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(self, _name: &'static str, _index: u32, variant: &'static str, value: &T) -> Result<(), Error> {
        let mut object = Object::open(self.out, b"}");
        object.serialize_entry(variant, value)?;
        object.end()
    }
    fn serialize_seq(self, _len: Option<usize>) -> Result<Seq<'a>, Error> {
        Ok(Seq::open(self.out, b"]"))
    }
    fn serialize_tuple(self, len: usize) -> Result<Seq<'a>, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_struct(self, _name: &'static str, len: usize) -> Result<Seq<'a>, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_variant(self, _name: &'static str, _index: u32, variant: &'static str, _len: usize) -> Result<Seq<'a>, Error> {
        variant_key(self.out, variant)?;
        Ok(Seq::open(self.out, b"]}"))
    }
    fn serialize_map(self, _len: Option<usize>) -> Result<Object<'a>, Error> {
        Ok(Object::open(self.out, b"}"))
    }
    fn serialize_struct(self, name: &'static str, _len: usize) -> Result<Struct<'a>, Error> {
        Ok(match name {
            RAW_VALUE => Struct::Raw(self.out),
            _ => Struct::Object(Object::open(self.out, b"}")),
        })
    }
    fn serialize_struct_variant(self, _name: &'static str, _index: u32, variant: &'static str, _len: usize) -> Result<Object<'a>, Error> {
        variant_key(self.out, variant)?;
        Ok(Object::open(self.out, b"}}"))
    }
}

/// The opening of `{"variant":…}`, whose one key needs no sorting.
fn variant_key(out: &mut Vec<u8>, variant: &str) -> Result<(), Error> {
    out.push(b'{');
    serde_json::to_writer(&mut *out, variant)?;
    out.push(b':');
    Ok(())
}

pub struct Seq<'a> {
    out: &'a mut Vec<u8>,
    first: bool,
    close: &'static [u8],
}

impl<'a> Seq<'a> {
    fn open(out: &'a mut Vec<u8>, close: &'static [u8]) -> Seq<'a> {
        out.push(b'[');
        Seq { out, first: true, close }
    }

    fn element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        if !self.first {
            self.out.push(b',');
        }
        self.first = false;
        value.serialize(Writer { out: self.out })
    }

    fn close(self) -> Result<(), Error> {
        self.out.extend_from_slice(self.close);
        Ok(())
    }
}

impl ser::SerializeSeq for Seq<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.element(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close()
    }
}

impl ser::SerializeTuple for Seq<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.element(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close()
    }
}

impl ser::SerializeTupleStruct for Seq<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.element(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close()
    }
}

impl ser::SerializeTupleVariant for Seq<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.element(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close()
    }
}

/// One object being written: its entries in `out` from `start`, each as
/// `"key":value`, and every key with the range its entry took.
pub struct Object<'a> {
    out: &'a mut Vec<u8>,
    start: usize,
    entries: Vec<(Cow<'static, str>, Range<usize>)>,
    in_order: bool,
    close: &'static [u8],
}

impl<'a> Object<'a> {
    fn open(out: &'a mut Vec<u8>, close: &'static [u8]) -> Object<'a> {
        out.push(b'{');
        let start = out.len();
        Object { out, start, entries: Vec::new(), in_order: true, close }
    }

    fn key(&mut self, key: Cow<'static, str>) -> Result<(), Error> {
        if let Some((last, _)) = self.entries.last() {
            self.out.push(b',');
            // An equal key is out of order too: only the rewrite drops one.
            self.in_order &= *last < key;
        }
        let at = self.out.len();
        serde_json::to_writer(&mut *self.out, key.as_ref())?;
        self.out.push(b':');
        self.entries.push((key, at..at));
        Ok(())
    }

    fn value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        value.serialize(Writer { out: self.out })?;
        if let Some((_, at)) = self.entries.last_mut() {
            at.end = self.out.len();
        }
        Ok(())
    }

    fn close(mut self) -> Result<(), Error> {
        if !self.in_order {
            self.rewrite_sorted();
        }
        self.out.extend_from_slice(self.close);
        Ok(())
    }

    fn rewrite_sorted(&mut self) {
        let written = self.out.split_off(self.start);
        // Stable, so of equal keys the one written last stays last.
        self.entries.sort_by(|(a, _), (b, _)| a.cmp(b));
        let mut first = true;
        for (i, (key, at)) in self.entries.iter().enumerate() {
            if self.entries.get(i + 1).is_some_and(|(next, _)| next == key) {
                continue;
            }
            if !first {
                self.out.push(b',');
            }
            first = false;
            self.out.extend_from_slice(&written[at.start - self.start..at.end - self.start]);
        }
    }
}

impl ser::SerializeMap for Object<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_key<T: ?Sized + Serialize>(&mut self, key: &T) -> Result<(), Error> {
        let key = map_key(key)?;
        self.key(Cow::Owned(key))
    }
    fn serialize_value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.value(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close()
    }
}

impl ser::SerializeStructVariant for Object<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, key: &'static str, value: &T) -> Result<(), Error> {
        self.key(Cow::Borrowed(key))?;
        self.value(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close()
    }
}

pub enum Struct<'a> {
    Object(Object<'a>),
    Raw(&'a mut Vec<u8>),
}

impl ser::SerializeStruct for Struct<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, key: &'static str, value: &T) -> Result<(), Error> {
        match self {
            Struct::Object(object) => {
                object.key(Cow::Borrowed(key))?;
                object.value(value)
            }
            Struct::Raw(out) if key == RAW_VALUE => {
                let parsed: Value = serde_json::from_str(&value.serialize(Text)?)?;
                serde_json::to_writer(&mut **out, &parsed)
            }
            Struct::Raw(_) => Err(Error::custom("a raw value holds one field, its text")),
        }
    }
    fn end(self) -> Result<(), Error> {
        match self {
            Struct::Object(object) => object.close(),
            Struct::Raw(_) => Ok(()),
        }
    }
}

/// A map key as the `Value`'s map holds it. A text is itself; anything else
/// (a number, a bool, a newtype) is what serde_json's own key serialiser
/// makes of it, read off a map of that one key.
fn map_key<T: ?Sized + Serialize>(key: &T) -> Result<String, Error> {
    if let Ok(text) = key.serialize(Text) {
        return Ok(text);
    }
    let mut map = serde_json::value::Serializer.serialize_map(Some(1))?;
    map.serialize_key(key)?;
    map.serialize_value(&())?;
    match map.end()? {
        Value::Object(map) => map.into_iter().next().map(|(key, _)| key).ok_or_else(|| Error::custom("a map of one key held none")),
        _ => Err(Error::custom("a map serialised as something else")),
    }
}

/// A value that is a text, taken as one; anything else is refused.
struct Text;

fn not_text() -> Error {
    Error::custom("not a text")
}

macro_rules! not_text {
    ($($method:ident($($arg:ty),*);)*) => {
        $(fn $method(self, $(_: $arg),*) -> Result<String, Error> {
            Err(not_text())
        })*
    };
}

impl ser::Serializer for Text {
    type Ok = String;
    type Error = Error;
    type SerializeSeq = Impossible<String, Error>;
    type SerializeTuple = Impossible<String, Error>;
    type SerializeTupleStruct = Impossible<String, Error>;
    type SerializeTupleVariant = Impossible<String, Error>;
    type SerializeMap = Impossible<String, Error>;
    type SerializeStruct = Impossible<String, Error>;
    type SerializeStructVariant = Impossible<String, Error>;

    fn serialize_str(self, v: &str) -> Result<String, Error> {
        Ok(v.to_owned())
    }

    not_text! {
        serialize_bool(bool);
        serialize_i8(i8);
        serialize_i16(i16);
        serialize_i32(i32);
        serialize_i64(i64);
        serialize_u8(u8);
        serialize_u16(u16);
        serialize_u32(u32);
        serialize_u64(u64);
        serialize_f32(f32);
        serialize_f64(f64);
        serialize_char(char);
        serialize_bytes(&[u8]);
        serialize_none();
        serialize_unit();
        serialize_unit_struct(&'static str);
        serialize_unit_variant(&'static str, u32, &'static str);
    }

    fn serialize_some<T: ?Sized + Serialize>(self, _value: &T) -> Result<String, Error> {
        Err(not_text())
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(self, _name: &'static str, _value: &T) -> Result<String, Error> {
        Err(not_text())
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(self, _name: &'static str, _index: u32, _variant: &'static str, _value: &T) -> Result<String, Error> {
        Err(not_text())
    }
    fn serialize_seq(self, _len: Option<usize>) -> Result<Self::SerializeSeq, Error> {
        Err(not_text())
    }
    fn serialize_tuple(self, _len: usize) -> Result<Self::SerializeTuple, Error> {
        Err(not_text())
    }
    fn serialize_tuple_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeTupleStruct, Error> {
        Err(not_text())
    }
    fn serialize_tuple_variant(self, _name: &'static str, _index: u32, _variant: &'static str, _len: usize) -> Result<Self::SerializeTupleVariant, Error> {
        Err(not_text())
    }
    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap, Error> {
        Err(not_text())
    }
    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeStruct, Error> {
        Err(not_text())
    }
    fn serialize_struct_variant(self, _name: &'static str, _index: u32, _variant: &'static str, _len: usize) -> Result<Self::SerializeStructVariant, Error> {
        Err(not_text())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::Serialize;
    use serde_json::json;
    use serde_json::value::RawValue;

    /// What `to_sorted_json` wrote before this writer: the oracle.
    fn through_value<T: ?Sized + Serialize>(value: &T) -> Result<Vec<u8>, String> {
        let value = serde_json::to_value(value).map_err(|e| e.to_string())?;
        Ok(serde_json::to_vec(&value).expect("a Value always serialises"))
    }

    fn written<T: ?Sized + Serialize>(value: &T) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        super::write(value, &mut out).map_err(|e| e.to_string())?;
        Ok(out)
    }

    /// The two agree byte for byte; an error on one side is an error on the
    /// other. Returns the text written, for a test that also pins it.
    fn same<T: ?Sized + Serialize>(value: &T) -> String {
        match (through_value(value), written(value)) {
            (Ok(old), Ok(new)) => {
                assert_eq!(String::from_utf8_lossy(&new), String::from_utf8_lossy(&old));
                String::from_utf8(new).unwrap()
            }
            (Err(_), Err(_)) => String::new(),
            (old, new) => panic!("the Value path gave {old:?}, the writer {new:?}"),
        }
    }

    /// A map that serialises its entries in the order given, duplicates
    /// included, as a hand-written `Serialize` may.
    struct Entries<K, V>(Vec<(K, V)>);

    impl<K: Serialize, V: Serialize> Serialize for Entries<K, V> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_map(self.0.iter().map(|(k, v)| (k, v)))
        }
    }

    #[test]
    fn empty_containers() {
        #[derive(Serialize)]
        struct Empty {}
        #[derive(Serialize)]
        struct Holder {
            z: Empty,
            a: Vec<u8>,
            m: BTreeMap<String, u8>,
        }
        assert_eq!(same(&Holder { z: Empty {}, a: vec![], m: BTreeMap::new() }), r#"{"a":[],"m":{},"z":{}}"#);
        same(&json!({}));
        same(&json!([]));
        same(&json!([{}, [], [[]], {"": {}}]));
    }

    #[test]
    fn keys_sort_by_their_utf8_bytes() {
        let keys = [
            "a", "ab", "aa", "a\u{0}", "a b", "", "B", "_", "ä", "e\u{301}", "é", "z", "😀", "\u{E000}", "\u{FFFF}", "\u{10000}", "\u{FDD0}",
            "\"", "[", "\\", "]", "\n", "\u{1}", "/", "\u{2028}", "0", "10", "9",
        ];
        // Reversed, so every one arrives out of order.
        let text = same(&Entries(keys.iter().rev().map(|k| (*k, 1)).collect()));
        let mut sorted = keys.to_vec();
        sorted.sort_unstable();
        let order: Vec<String> = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text).unwrap().keys().cloned().collect();
        assert_eq!(order, sorted);
        // A quote sorts as the character, not as its escape.
        assert!(text.find(r#""\"""#).unwrap() < text.find(r#""[""#).unwrap(), "{text}");
        same(&Entries(keys.iter().map(|k| (*k, 1)).collect()));
    }

    #[test]
    fn a_repeated_key_keeps_its_last_value() {
        assert_eq!(same(&Entries(vec![("b", 1), ("a", 2), ("b", 3)])), r#"{"a":2,"b":3}"#);
        assert_eq!(same(&Entries(vec![("a", 1), ("a", 2)])), r#"{"a":2}"#);
        assert_eq!(same(&Entries(vec![("a", 1), ("b", 2), ("a", 3), ("a", 4), ("c", 5)])), r#"{"a":4,"b":2,"c":5}"#);
    }

    #[test]
    fn keys_that_are_not_texts() {
        same(&BTreeMap::from([(9u32, "n"), (10, "t"), (100, "h")]));
        same(&Entries(vec![(-1i64, 1), (i64::MIN, 2), (u64::MAX as i64, 3)]));
        same(&Entries(vec![(true, 1), (false, 2)]));
        same(&Entries(vec![('b', 1), ('a', 2)]));
        same(&Entries(vec![(1.5f64, 1), (-0.0, 2)]));
        same(&Entries(vec![(f64::NAN, 1)]));
        #[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
        struct Wrapped(String);
        same(&Entries(vec![(Wrapped("z".into()), 1), (Wrapped("a".into()), 2)]));
        #[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
        enum Unit {
            Zed,
            Ay,
        }
        same(&Entries(vec![(Unit::Zed, 1), (Unit::Ay, 2)]));
        // Refused by both.
        same(&Entries(vec![(vec![1], 1)]));
        same(&Entries(vec![((), 1)]));
        same(&Entries(vec![(Some("a"), 1)]));
    }

    #[test]
    fn numbers() {
        same(&json!([0, -1, i64::MIN, i64::MAX, u64::MAX]));
        same(&[0.0f64, -0.0, 1.0, 0.1, 1e300, 5e-324, f64::MAX, f64::MIN_POSITIVE, 1e21, 1e-7, 123456789.125]);
        same(&[f64::NAN, f64::INFINITY, f64::NEG_INFINITY]);
        same(&[0.1f32, 1.0, -0.0, f32::NAN, 3.4e38]);
        same(&[0i128, -5, i64::MIN as i128, u64::MAX as i128]);
        same(&(i64::MIN as i128 - 1));
        same(&(u64::MAX as u128 + 1));
        same(&[1u8, 2, 255]);
        same(&(i8::MIN, i16::MIN, i32::MIN, u16::MAX, u32::MAX));
        let js = [0.0, -0.0, 5.0, 0.5, 9_007_199_254_740_993.0, f64::NAN, -1e-300].map(crate::tree::JsNumber);
        same(&js);
    }

    #[test]
    fn texts_and_the_rest() {
        same(&["", "\"\\/\u{0}\u{1f}\u{7f}\n\r\t\u{8}\u{c}", "é😀\u{2028}\u{2029}\u{FDD0}\u{10FFFF}"]);
        same(&['a', '"', '😀']);
        same(&serde_bytes_like(&[0, 1, 255]));
        same(&());
        same(&(1, "two", [3.0]));
        #[derive(Serialize)]
        struct UnitStruct;
        #[derive(Serialize)]
        struct Newtype(Vec<u8>);
        #[derive(Serialize)]
        struct Tuple(u8, &'static str);
        same(&(UnitStruct, Newtype(vec![1]), Tuple(1, "a"), None::<u8>, Some(Some(3))));
    }

    /// Bytes as serde writes them for a `&[u8]` it is told are bytes.
    fn serde_bytes_like(bytes: &[u8]) -> impl Serialize + '_ {
        struct Bytes<'a>(&'a [u8]);
        impl Serialize for Bytes<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_bytes(self.0)
            }
        }
        Bytes(bytes)
    }

    #[test]
    fn every_shape_of_enum_and_struct() {
        #[derive(Serialize)]
        enum External {
            Unit,
            New(u8),
            Tuple(u8, String),
            Struct { zeta: u8, alpha: Vec<External> },
        }
        #[derive(Serialize)]
        #[serde(tag = "kind", rename_all = "camelCase")]
        enum Internal {
            Zebra { y: u8, b: u8 },
            Apple(Inner),
        }
        #[derive(Serialize)]
        #[serde(tag = "t", content = "c")]
        enum Adjacent {
            Z { y: u8, b: u8 },
        }
        #[derive(Serialize)]
        #[serde(untagged)]
        enum Untagged {
            Inner(Inner),
            Text(String),
        }
        #[derive(Serialize)]
        struct Inner {
            y: u8,
            b: u8,
            #[serde(skip_serializing_if = "Option::is_none")]
            absent: Option<u8>,
        }
        #[derive(Serialize)]
        struct Flattening {
            zz: u8,
            #[serde(flatten)]
            inner: Inner,
            #[serde(flatten)]
            more: BTreeMap<String, u8>,
            aa: u8,
        }
        let inner = || Inner { y: 1, b: 2, absent: None };
        same(&External::Unit);
        same(&External::New(1));
        same(&External::Tuple(1, "x".into()));
        let nested = External::Struct { zeta: 1, alpha: vec![External::Unit, External::Struct { zeta: 2, alpha: vec![] }] };
        assert_eq!(same(&nested), r#"{"Struct":{"alpha":["Unit",{"Struct":{"alpha":[],"zeta":2}}],"zeta":1}}"#);
        same(&[Internal::Zebra { y: 1, b: 2 }, Internal::Apple(inner())]);
        same(&Adjacent::Z { y: 1, b: 2 });
        same(&[Untagged::Inner(Inner { absent: Some(3), ..inner() }), Untagged::Text("t".into())]);
        let more = BTreeMap::from([("b".to_string(), 9), ("zz".to_string(), 8), ("c".to_string(), 7)]);
        // Flattened entries arrive as a map's, `zz` twice: the later wins.
        assert_eq!(same(&Flattening { zz: 1, inner: inner(), more, aa: 2 }), r#"{"aa":2,"b":9,"c":7,"y":1,"zz":8}"#);
    }

    #[test]
    fn raw_values_are_written_as_the_value_they_read_as() {
        let raw = |text: &str| RawValue::from_string(text.to_string()).unwrap();
        #[derive(Serialize)]
        struct Holder {
            z: Box<RawValue>,
            a: Vec<Box<RawValue>>,
            m: BTreeMap<String, Box<RawValue>>,
        }
        let holder = Holder {
            z: raw(r#" { "b" : 1 , "a" : { "y": [ 1e2, -0, 0.10, 18446744073709551616 ], "x": null } , "b": 2 } "#),
            a: vec![raw("1.0"), raw("-0"), raw(r#""é😀\/""#), raw("[]"), raw("{}"), raw("true")],
            m: BTreeMap::from([("k".to_string(), raw(r#"{"z":{"y":{"x":1}},"a":0}"#))]),
        };
        assert_eq!(
            same(&holder),
            r#"{"a":[1.0,-0.0,"é😀/",[],{},true],"m":{"k":{"a":0,"z":{"y":{"x":1}}}},"z":{"a":{"x":null,"y":[100.0,-0.0,0.1,1.8446744073709552e+19]},"b":2}}"#,
        );
        same(&raw("123"));
        // Nested past serde_json's own read limit: refused by both.
        same(&raw(&format!("{}{}", "[".repeat(200), "]".repeat(200))));
    }

    #[test]
    fn values_and_deep_nesting() {
        let value: serde_json::Value = serde_json::from_str(r#"{"b":[{"d":1,"c":{"f":2.5,"e":"x"}}],"a":null}"#).unwrap();
        same(&value);
        let depth = crate::util::json::MAX_DEPTH;
        let deep = format!("{}1{}", r#"{"b":[{"a":"#.repeat(depth / 3), "}]}".repeat(depth / 3));
        // Read, written and dropped on a stack with room for the recursion.
        let text = std::thread::Builder::new()
            .stack_size(256 << 20)
            .spawn(move || same(&crate::util::json::read_bounded(&deep).unwrap()))
            .unwrap()
            .join()
            .unwrap();
        assert!(text.starts_with(r#"{"b":[{"a":{"b":[{"a":"#));
    }
}
