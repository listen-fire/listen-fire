//! Event-address narrowing under lf: lf-platform's
//! `translation_graph/movement/listen_narrowing.ts` (`narrowEventPositions`,
//! `graftAddress`), ported rule for rule. The why of each rule is there; the
//! comments here say only what lf does differently.
//!
//! A movement's signature names the full address of the event it takes
//! (`<hiring-[:`Record Change` WHERE `table` == "tblCAND01"]->>`). Each
//! address a signature names gets a copy of the event node under the
//! address's key, its edges that land on the unnarrowed collection (Airtable's
//! `Table`: `Record`, `Old Record`) retargeted at the node the address walks
//! to. So the parameter reads the named table's fields, typed. The walk is
//! the module's own `edgesFrom`, hop by hop from the connection's root, as the
//! platform walks it; a module without `edgesFrom`, or an address that walks
//! nowhere, grafts nothing and the parameter stays as the module described it.
//!
//! The keys an address pins are the module's listen config keys that declare
//! `narrows`, less the leading ones the connection's entry position consumed
//! (`connect airtable … { base: "Hiring" }` consumes `base`). They are
//! published as `eventNarrowingKeys`, and what each may be pinned to as
//! `eventNarrowingValues`, as the platform publishes them.

use std::cell::RefCell;
use std::collections::BTreeMap;

use indexmap::IndexMap;
use movement_checker::types::event_address::{EventAddress, event_address_key, event_address_of_hops, narrowing_prefix_key};
use movement_parser::ast::{ParamTypeRef, RValue, Statement};

use std::rc::Rc;

use crate::check::ConnectionWalk;
use crate::externals::RunningExternal;
use crate::json::{Js, Obj};
use crate::obj;
use crate::routing::Listen;
use crate::secrets::{Construction, Credentials, construction_of, credential_for};

/// `EVENT_ACTION_FIELD`: the change-kind axis an event node may declare.
const EVENT_ACTION_FIELD: &str = "action";
/// `RECORD_DELETED_ACTION`.
const RECORD_DELETED_ACTION: &str = "record.deleted";
/// `MAX_WALK_PAGES`: how many pages of one hop's edges a walk reads.
const MAX_WALK_PAGES: usize = 100;
/// `META_RECORD_TYPE`: the root a walk starts from.
const META_RECORD_TYPE: &str = "meta";

/// An event address a movement's signature names, and the construction it
/// is named against (`referencedEventAddresses`' `EventAddressRef`).
#[derive(Clone, Debug, PartialEq)]
pub struct SignatureAddress {
    pub construction: Construction,
    pub movement: String,
    pub address: EventAddress,
}

/// `referencedEventAddresses`: the addresses the movements' parameters name,
/// each against the construction its instance is bound to. A parameter typed
/// against a name that is no construction ends its movement's search, and a
/// hop that is no address is skipped, as there.
pub fn signature_addresses(statements: &[Statement], originals: &BTreeMap<String, String>) -> Vec<SignatureAddress> {
    let mut bindings = BTreeMap::new();
    let mut addresses = Vec::new();
    collect(statements, originals, &mut bindings, &mut addresses);
    addresses
}

fn collect(statements: &[Statement], originals: &BTreeMap<String, String>, bindings: &mut BTreeMap<String, Construction>, into: &mut Vec<SignatureAddress>) {
    for statement in statements {
        match statement {
            Statement::Assign(assign) => match &assign.value {
                RValue::Construct { construct } => {
                    bindings.insert(assign.name.clone(), construction_of(construct, originals));
                }
                RValue::Block { block } => collect(&block.body, originals, bindings, into),
                _ => {}
            },
            Statement::Movement(movement) => {
                for param in &movement.params {
                    let Some(ParamTypeRef::Name(type_ref)) = &param.type_ else { continue };
                    let Some(hops) = &type_ref.hops_raw else { continue };
                    let Some(construction) = bindings.get(&type_ref.graph) else { break };
                    let Some(address) = event_address_of_hops(hops) else { continue };
                    into.push(SignatureAddress { construction: construction.clone(), movement: movement.name.clone(), address });
                }
                collect(&movement.body, originals, bindings, into);
            }
            Statement::Block(block) => collect(&block.block.body, originals, bindings, into),
            Statement::If(branch) => {
                for arm in &branch.arms {
                    collect(&arm.body, originals, bindings, into);
                }
                if let Some(otherwise) = &branch.else_arm {
                    collect(&otherwise.body, originals, bindings, into);
                }
            }
            _ => {}
        }
    }
}

/// One hop of an event address: a listen config key that `narrows`, the
/// collection it walks along and the member field its value is matched on.
#[derive(Clone, Debug, PartialEq)]
pub struct AddressHop {
    pub key: String,
    pub collection: String,
    pub match_field: String,
}

/// `addressHops` less `positionConsumedHopKeys`: the module's address hops,
/// in declaration order, after the leading ones the connection's entry
/// position pins (`position_values`, by position arg).
pub fn address_hops(listen: &Obj, position_values: &BTreeMap<String, String>) -> Vec<AddressHop> {
    let declared: Vec<AddressHop> = listen
        .get("listenConfig")
        .and_then(Js::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let narrows = entry.get("narrows")?;
            Some(AddressHop {
                key: entry.get("key")?.as_str()?.to_string(),
                collection: narrows.get("collection")?.as_str()?.to_string(),
                match_field: narrows.get("matchField")?.as_str()?.to_string(),
            })
        })
        .collect();
    let consumed = declared.iter().take_while(|hop| position_values.contains_key(&hop.key)).count();
    declared.into_iter().skip(consumed).collect()
}

/// `resolveListenAddress`: each declared hop's value, from the listen's
/// config (already an id) or else from the connection's entry position (a
/// member's label, or its id), the latter resolved by walking the hop's
/// members from the root. A hop neither names, or a position naming no
/// member, fails the whole address, naming why. Unlike the platform, a
/// config value is taken as written rather than walked to validate it: the
/// checker has already held it to the walked values.
pub async fn resolve_listen_address<W: Walk>(
    walk: &W,
    adapter_type: &str,
    hops: &[AddressHop],
    config: &Obj,
    position_values: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let walker = Walker { walk, adapter_type, hops: RefCell::new(BTreeMap::new()) };
    let mut address = BTreeMap::new();
    let mut steps: Vec<Step> = Vec::new();
    for hop in hops {
        let value = match (config.get(&hop.key).and_then(Js::as_str).filter(|v| !v.is_empty()), position_values.get(&hop.key)) {
            (Some(named), _) => named.to_string(),
            (None, Some(positioned)) => {
                let members = walker.members_at(&steps, &hop.collection).await?;
                if members.is_empty() {
                    return Err(format!("couldn't read the connection's {} options to resolve its '{}' \"{positioned}\"", hop.collection, hop.key));
                }
                let id = |m: &Js| m.get(&hop.match_field).and_then(Js::as_str).map(str::to_string);
                let found = members.iter().find(|m| member_label(m) == Some(positioned.as_str()) || id(m).as_deref() == Some(positioned.as_str()));
                match found.and_then(id) {
                    Some(id) => id,
                    None => {
                        let known: Vec<&str> = members.iter().filter_map(member_label).collect();
                        return Err(format!("its connection is positioned at '{}' \"{positioned}\", which isn't one the connection can see — it has: {}", hop.key, known.join(", ")));
                    }
                }
            }
            (None, None) => return Err(format!("it names no '{}' and its connection isn't positioned at one", hop.key)),
        };
        steps.push(Step { collection: hop.collection.clone(), match_field: hop.match_field.clone(), value: value.clone() });
        address.insert(hop.key.clone(), value);
    }
    Ok(address)
}

/// Each listen's address where its config leaves one of its module's webhook
/// scope keys (`subscriptionScopeKeys`) to its connection's position (`connect
/// airtable … { base: "Hiring" }`): what the platform keeps as a trigger's
/// `resolved_address`. A listen that names every scope key, or whose
/// connection names no position, is left as it is.
pub async fn resolve_listen_addresses(listens: &mut [Listen], running: &[Rc<RunningExternal>], credentials: &Credentials) {
    for listen in listens.iter_mut() {
        let Some(external) = running.iter().find(|r| r.external.manifest.name == listen.adapter && !r.is_plugin()) else { continue };
        let keys = external.subscription_scope_keys();
        if keys.iter().all(|k| listen.config.get(k).and_then(Js::as_str).is_some_and(|v| !v.is_empty())) {
            continue;
        }
        let position_values: BTreeMap<String, String> = match external.position_settings(&listen.args) {
            Some(serde_json::Value::Object(settings)) => settings.into_iter().filter_map(|(k, v)| Some((k, v.as_str()?.to_string()))).collect(),
            _ => continue,
        };
        let credential = match &listen.credential {
            Some(name) => credentials.iter().find(|c| c.name == *name),
            None => credential_for(credentials, &listen.adapter),
        };
        // The root unpositioned: the position is what is being resolved.
        let walk = ConnectionWalk { running: external, credentials, credential, settings: None };
        let adapter_type = external.manifest_answer.get("adapterType").and_then(Js::as_str).unwrap_or(&external.external.manifest.name);
        let hops = address_hops(&external.listen, &BTreeMap::new());
        listen.address = resolve_listen_address(&walk, adapter_type, &hops, &listen.config, &position_values).await;
    }
}

/// `memberLabel`: the label a position arg names a member by.
fn member_label(data: &Js) -> Option<&str> {
    let Js::Obj(data) = data else { return None };
    let named = ["Title", "Name", "name", "title"].iter().find_map(|k| data.get(*k).and_then(Js::as_str).filter(|v| !v.is_empty()));
    named.or_else(|| data.values().find_map(|v| v.as_str().filter(|v| !v.is_empty())))
}

/// `withEventNarrowingKeys`.
pub fn with_event_narrowing_keys(schema: Js, hops: &[AddressHop]) -> Js {
    let Js::Obj(mut schema) = schema else { return schema };
    if !hops.is_empty() {
        schema.insert("eventNarrowingKeys".into(), Js::strings(hops.iter().map(|h| &h.key)));
    }
    Js::Obj(schema)
}

/// One hop of a walk, pinned: `hopStep`'s `-[:<collection> WHERE
/// `<matchField>` == "<value>"]->`.
#[derive(Clone, Debug, PartialEq)]
struct Step {
    collection: String,
    match_field: String,
    value: String,
}

impl Step {
    /// The step as the platform's `AddressStep` JSON: the same AST a WHERE
    /// parses to, so a record key here is the platform's.
    fn js(&self) -> Js {
        Js::Obj(obj! {
            "type" => Js::str("edge"),
            "edgeTypeId" => Js::str(&self.collection),
            "expressionFilter" => Js::Obj(obj! {
                "type" => Js::str("compare"),
                "op" => Js::str("eq"),
                "left" => Js::Obj(obj! { "type" => Js::str("property"), "propertyTypeId" => Js::str(&self.match_field) }),
                "right" => Js::Obj(obj! { "type" => Js::str("static"), "value" => Js::str(&self.value) }),
            }),
        })
    }
}

/// One `edgesFrom` call of the connection being described: its answer, or
/// `Js::Null` when it has no edges there (or no `edgesFrom` at all).
pub trait Walk {
    async fn edges_from(&self, position: &Js, cursor: Option<&Js>) -> Result<Js, String>;
}

/// The walks of one connection (`walkHop`, `walkPath`, `membersAtPath`),
/// each hop taken once however many walks pass through it.
struct Walker<'a, W> {
    walk: &'a W,
    adapter_type: &'a str,
    hops: RefCell<BTreeMap<String, Option<Js>>>,
}

impl<W: Walk> Walker<'_, W> {
    async fn hop(&self, position: &Js) -> Result<Option<Js>, String> {
        let at = position.to_json();
        if let Some(hop) = self.hops.borrow().get(&at) {
            return Ok(hop.clone());
        }
        let hop = self.drain_hop(position).await?;
        self.hops.borrow_mut().insert(at, hop.clone());
        Ok(hop)
    }

    /// `drainHop`: one hop's every page, merged.
    async fn drain_hop(&self, position: &Js) -> Result<Option<Js>, String> {
        let first = self.walk.edges_from(position, None).await?;
        if first == Js::Null {
            return Ok(None);
        }
        let list = |hop: &Js, key: &str| hop.get("descriptor").and_then(|d| d.get(key)).and_then(Js::as_array).unwrap_or_default().to_vec();
        let map = |hop: &Js, key: &str| match hop.get(key) {
            Some(Js::Obj(map)) => map.clone(),
            _ => Obj::new(),
        };
        let (mut fields, mut references) = (list(&first, "fields"), list(&first, "references"));
        let (mut target_positions, mut target_nodes) = (map(&first, "targetPositions"), map(&first, "targetNodes"));
        let mut cursor = first.get("nextCursor").filter(|c| **c != Js::Null).cloned();
        let mut page = 1;
        while let Some(at) = cursor.take().filter(|_| page < MAX_WALK_PAGES) {
            let next = self.walk.edges_from(position, Some(&at)).await?;
            if next == Js::Null {
                break;
            }
            fields.extend(list(&next, "fields"));
            references.extend(list(&next, "references"));
            target_positions.extend(map(&next, "targetPositions"));
            target_nodes.extend(map(&next, "targetNodes"));
            cursor = next.get("nextCursor").filter(|c| **c != Js::Null).cloned();
            page += 1;
        }
        let mut descriptor = match first.get("descriptor") {
            Some(Js::Obj(descriptor)) => descriptor.clone(),
            _ => Obj::new(),
        };
        descriptor.insert("fields".into(), Js::Arr(fields));
        descriptor.insert("references".into(), Js::Arr(references));
        let mut hop = obj! { "descriptor" => Js::Obj(descriptor), "targetPositions" => Js::Obj(target_positions) };
        if !target_nodes.is_empty() {
            hop.insert("targetNodes".into(), Js::Obj(target_nodes));
        }
        Ok(Some(Js::Obj(hop)))
    }

    async fn root(&self) -> Result<Option<Js>, String> {
        let meta = Js::Obj(obj! {
            "adapterType" => Js::str(self.adapter_type),
            "recordType" => Js::str(META_RECORD_TYPE),
            "identity" => Js::Obj(obj! { "kind" => Js::str("unstable") }),
        });
        self.hop(&meta).await
    }

    /// `walkHop`: the hop a path lands on.
    async fn walk_hop(&self, steps: &[Step]) -> Result<Option<Js>, String> {
        let mut hop = self.root().await?;
        for step in steps {
            let Some(next) = hop.as_ref().and_then(|hop| step_to(hop, step)) else { return Ok(None) };
            hop = self.hop(&next).await?;
        }
        Ok(hop)
    }

    /// `walkPath`: the descriptor a path lands on.
    async fn walk_to(&self, steps: &[Step]) -> Result<Option<Js>, String> {
        Ok(self.walk_hop(steps).await?.and_then(|hop| hop.get("descriptor").cloned()))
    }

    /// `membersAtPath`: the data of the members of kind `record_type` one hop
    /// on from where a path lands, each named by its edge or its label.
    async fn members_at(&self, steps: &[Step], record_type: &str) -> Result<Vec<Js>, String> {
        let Some(hop) = self.walk_hop(steps).await? else { return Ok(Vec::new()) };
        let references = hop.get("descriptor").and_then(|d| d.get("references")).and_then(Js::as_array).unwrap_or_default();
        let edge_named = |field_id: &str| references.iter().any(|r| r.get("fieldId").and_then(Js::as_str) == Some(field_id));
        let Some(Js::Obj(positions)) = hop.get("targetPositions") else { return Ok(Vec::new()) };
        Ok(positions
            .iter()
            .filter(|(_, position)| position.get("recordType").and_then(Js::as_str) == Some(record_type))
            .filter(|(field_id, position)| edge_named(field_id) || position_label(position).is_some())
            .map(|(_, position)| position_data(position).cloned().unwrap_or(Js::Null))
            .collect())
    }
}

fn position_data(position: &Js) -> Option<&Js> {
    position.get("identity").and_then(|i| i.get("data"))
}

/// `positionLabel`.
fn position_label(position: &Js) -> Option<&str> {
    position_data(position).and_then(member_label)
}

/// `stepTo` for a pinned hop: the first member of the hop's collection
/// (a member whose `recordType` is unset belongs to any) whose data has
/// the pinned value.
fn step_to(hop: &Js, step: &Step) -> Option<Js> {
    let Some(Js::Obj(positions)) = hop.get("targetPositions") else { return None };
    positions
        .values()
        .filter(|p| match p.get("recordType") {
            None | Some(Js::Null) => true,
            Some(kind) => kind.as_str() == Some(step.collection.as_str()),
        })
        .find(|p| position_data(p).and_then(|d| d.get(&step.match_field)) == Some(&Js::str(&step.value)))
        .cloned()
}

/// What a connection's event positions are narrowed with.
pub struct Narrowing<'a, W> {
    /// The adapter the catalog files the connection under.
    pub adapter: &'a str,
    /// The module's own `adapterType`, which its positions carry.
    pub adapter_type: &'a str,
    pub hops: &'a [AddressHop],
    /// The addresses the signatures name against this connection.
    pub addresses: &'a [EventAddress],
    /// Its `listEntryPoints` answer, for projecting a walked node.
    pub entries: &'a [Js],
    pub walk: &'a W,
}

/// `narrowEventPositions`: `schema` with one narrowed event position per
/// address. No addresses or no event edges, and it comes back as it was.
pub async fn narrow_event_positions<W: Walk>(schema: Js, input: &Narrowing<'_, W>) -> Js {
    let event_names: Vec<String> =
        schema.get("eventPositions").and_then(Js::as_array).unwrap_or_default().iter().filter_map(|e| e.get("position").and_then(Js::as_str).map(str::to_string)).collect();
    if input.addresses.is_empty() || event_names.is_empty() {
        return schema;
    }
    let Js::Obj(mut schema) = schema else { return schema };
    let walker = Walker { walk: input.walk, adapter_type: input.adapter_type, hops: RefCell::new(BTreeMap::new()) };
    let hops = input.hops;
    let narrowed_from = hops.last().map(|h| h.collection.clone());

    if !hops.is_empty() {
        let values = narrowing_values(hops, input.addresses, &walker).await;
        if !values.is_empty() {
            schema.insert("eventNarrowingValues".into(), Js::Obj(values));
        }
    }

    // The record position a walk landed on, by its key; None where it landed nowhere.
    let mut walked: IndexMap<String, Option<String>> = IndexMap::new();
    for address in input.addresses {
        if !event_names.contains(&address.event) {
            continue;
        }
        let Some(source) = position(&schema, &address.event).cloned() else { continue };
        let action_enum: Option<Vec<String>> = match source.get("properties").and_then(|p| p.get(EVENT_ACTION_FIELD)) {
            Some(action) if action.get("kind").and_then(Js::as_str) == Some("enum") => {
                Some(action.get("options").and_then(Js::as_array).unwrap_or_default().iter().filter_map(Js::as_str).map(str::to_string).collect())
            }
            _ => None,
        };
        let pin = |key: &str| address.narrowing.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        let action_pin = pin(EVENT_ACTION_FIELD);
        let rest: Vec<&(String, String)> = address.narrowing.iter().filter(|(k, _)| k != EVENT_ACTION_FIELD).collect();
        if rest.iter().any(|(k, _)| !hops.iter().any(|h| h.key == *k)) {
            continue;
        }
        let hop_pins: BTreeMap<&str, &str> = rest.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        if let Some(action) = &action_pin
            && !action_enum.as_ref().is_some_and(|options| options.contains(action))
        {
            continue;
        }
        // An address that pins nothing is the wide type (`EventAddressRef`'s
        // own word): nothing to graft. The platform's code unions it by
        // action all the same, which under lf would refuse a 0.12.9 program
        // that reads a live-record edge off an unnarrowed signature (the Attio
        // walkthrough's `<crm-[e:`Webhook Event`]->>`).
        if address.narrowing.is_empty() {
            continue;
        }
        let address_key = event_address_key(address);
        let unioned = schema.get("unions").and_then(|u| u.get(&address_key)).is_some();
        if unioned || (address_key != address.event && position(&schema, &address_key).is_some()) {
            continue;
        }

        let mut record_target = None;
        if !hop_pins.is_empty() {
            let Some(steps) = address_of(hops, &hop_pins) else { continue };
            let record_key = format!("{}::record::{}", input.adapter, Js::Arr(steps.iter().map(Step::js).collect()).to_json());
            if !walked.contains_key(&record_key) {
                // A walk that fails narrows nothing (the platform notes it; lf has nowhere to).
                let landed = match walker.walk_to(&steps).await {
                    Ok(Some(descriptor)) => project_record_position(input, &descriptor, &record_key),
                    Ok(None) | Err(_) => None,
                };
                walked.insert(record_key.clone(), landed.as_ref().map(|p| p.get("displayName").and_then(Js::as_str).unwrap_or_default().to_string()));
                if let Some(position) = landed {
                    positions_mut(&mut schema).insert(record_key.clone(), position);
                }
            }
            if walked.get(&record_key).is_none_or(Option::is_none) {
                continue;
            }
            record_target = Some(record_key);
        }

        graft_address(&mut schema, Graft {
            source: &source,
            address,
            address_key: &address_key,
            action_enum: action_enum.as_deref(),
            from: narrowed_from.as_deref(),
            to: record_target.as_deref(),
        });
    }
    Js::Obj(schema)
}

fn position<'a>(schema: &'a Obj, key: &str) -> Option<&'a Js> {
    schema.get("positions").and_then(|p| p.get(key))
}

fn positions_mut(schema: &mut Obj) -> &mut Obj {
    match schema.entry("positions".to_string()).or_insert_with(|| Js::Obj(Obj::new())) {
        Js::Obj(positions) => positions,
        other => {
            *other = Js::Obj(Obj::new());
            let Js::Obj(positions) = other else { unreachable!() };
            positions
        }
    }
}

/// `addressOf`: the walk an address stands for, when it pins every hop.
fn address_of(hops: &[AddressHop], pins: &BTreeMap<&str, &str>) -> Option<Vec<Step>> {
    let steps: Option<Vec<Step>> = hops
        .iter()
        .map(|hop| pins.get(hop.key.as_str()).map(|value| Step { collection: hop.collection.clone(), match_field: hop.match_field.clone(), value: value.to_string() }))
        .collect();
    steps.filter(|s| !s.is_empty())
}

/// `narrowingValues`: what may be pinned at each hop, by the prefix pinned
/// before it, walked only as far as the addresses go. A hop whose members
/// cannot be read publishes nothing, as one that has none.
async fn narrowing_values<W: Walk>(hops: &[AddressHop], addresses: &[EventAddress], walker: &Walker<'_, W>) -> Obj {
    let mut values = Obj::new();
    let mut options_at: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for address in addresses {
        let mut pinned: Vec<(String, String)> = Vec::new();
        let mut steps: Vec<Step> = Vec::new();
        for hop in hops {
            let prefix = narrowing_prefix_key(&pinned);
            let memo = format!("{prefix}::{}", hop.key);
            let options = match options_at.get(&memo) {
                Some(options) => options.clone(),
                None => {
                    let members = walker.members_at(&steps, &hop.collection).await.unwrap_or_default();
                    let options: Vec<String> = members.iter().filter_map(|m| m.get(&hop.match_field).and_then(Js::as_str).map(str::to_string)).collect();
                    options_at.insert(memo, options.clone());
                    options
                }
            };
            if options.is_empty() {
                break;
            }
            let at = values.entry(prefix).or_insert_with(|| Js::Obj(Obj::new()));
            if let Js::Obj(at) = at {
                at.insert(hop.key.clone(), Js::strings(&options));
            }
            let Some(value) = address.narrowing.iter().find(|(k, _)| *k == hop.key).map(|(_, v)| v.clone()).filter(|v| options.contains(v)) else { break };
            pinned.push((hop.key.clone(), value.clone()));
            steps.push(Step { collection: hop.collection.clone(), match_field: hop.match_field.clone(), value });
        }
    }
    values
}

/// `projectRecordPosition`: the walked node as a position under an opaque
/// key, the table's own name its display.
fn project_record_position<W>(input: &Narrowing<'_, W>, descriptor: &Js, key: &str) -> Option<Js> {
    let synthetic = format!("{key}::type");
    let mut entries = input.entries.to_vec();
    entries.push(Js::Obj(obj! { "typeId" => Js::str(&synthetic), "displayName" => Js::str(key), "readable" => Js::Bool(true), "writable" => Js::Bool(false) }));
    let descriptors: IndexMap<String, Js> = [(synthetic, descriptor.clone())].into_iter().collect();
    let projected = crate::schema::instance_schema_from_descriptors(&crate::schema::ProjectionInput {
        adapter_type: input.adapter,
        entries: &entries,
        reached: &[],
        descriptors: &descriptors,
        meta_descriptor: None,
        supports_in_place_update: false,
        edges_carry_properties: false,
        all_entries: None,
        lazily_walked: false,
    });
    let Some(Js::Obj(mut position)) = projected.schema.get("positions").and_then(|p| p.get(key)).cloned() else { return None };
    position.insert("displayName".into(), descriptor.get("displayName").cloned().unwrap_or(Js::Null));
    Some(Js::Obj(position))
}

struct Graft<'a> {
    /// The event node's own position: what every copy copies.
    source: &'a Js,
    address: &'a EventAddress,
    address_key: &'a str,
    /// The node's `action` options, when it declares that axis.
    action_enum: Option<&'a [String]>,
    /// The collection the record edges land on before narrowing (`Table`).
    from: Option<&'a str>,
    /// The walked record position's key, when the address pinned the hops.
    to: Option<&'a str>,
}

/// `eventAddressDisplay`.
fn address_display(event: &str, pins: &[(String, String)]) -> String {
    if pins.is_empty() {
        return event.to_string();
    }
    let mut pins = pins.to_vec();
    pins.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    let pins: Vec<String> = pins.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!("{event} where {}", pins.join(", "))
}

/// `graftAddress`: the address's own position(s), each a copy of the event
/// node with its edges onto `from` retargeted at `to`, and its edges that
/// need a live record dropped under a deleted `action` pin; a union of one
/// per action when the address leaves the axis open.
fn graft_address(schema: &mut Obj, graft: Graft<'_>) {
    let event = &graft.address.event;
    let copy_for = |pins: &[(String, String)]| -> Js {
        let record_gone = pins.iter().any(|(k, v)| k == EVENT_ACTION_FIELD && v == RECORD_DELETED_ACTION);
        let mut edges = Obj::new();
        if let Some(Js::Obj(source_edges)) = graft.source.get("edges") {
            for (name, edge) in source_edges {
                if record_gone && Js::is_true(edge.get("requiresLiveRecord")) {
                    continue;
                }
                let lands_on_from = graft.from.is_some() && edge.get("target").and_then(Js::as_str) == graft.from;
                let edge = match (graft.to, edge) {
                    (Some(to), Js::Obj(fields)) if lands_on_from => {
                        let mut fields = fields.clone();
                        fields.insert("target".into(), Js::str(to));
                        Js::Obj(fields)
                    }
                    _ => edge.clone(),
                };
                edges.insert(name.clone(), edge);
            }
        }
        let mut copy = match graft.source {
            Js::Obj(source) => source.clone(),
            _ => Obj::new(),
        };
        copy.insert("edges".into(), Js::Obj(edges));
        copy.insert("displayName".into(), Js::str(address_display(event, pins)));
        Js::Obj(copy)
    };
    let narrowing = &graft.address.narrowing;
    let action_pinned = narrowing.iter().any(|(k, _)| k == EVENT_ACTION_FIELD);
    match graft.action_enum.filter(|_| !action_pinned) {
        None => {
            let copy = copy_for(narrowing);
            positions_mut(schema).insert(graft.address_key.to_string(), copy);
        }
        Some(actions) => {
            let mut variant_keys = Vec::new();
            for action in actions {
                let mut pins = narrowing.clone();
                pins.push((EVENT_ACTION_FIELD.to_string(), action.clone()));
                let key = event_address_key(&EventAddress { event: event.clone(), narrowing: pins.clone() });
                if position(schema, &key).is_none() {
                    let copy = copy_for(&pins);
                    positions_mut(schema).insert(key.clone(), copy);
                }
                variant_keys.push(key);
            }
            insert_into(schema, "unions", graft.address_key, Js::strings(&variant_keys));
            if graft.address_key != event {
                insert_into(schema, "unionDisplayNames", graft.address_key, Js::str(address_display(event, narrowing)));
            }
        }
    }
}

fn insert_into(schema: &mut Obj, map: &str, key: &str, value: Js) {
    match schema.entry(map.to_string()).or_insert_with(|| Js::Obj(Obj::new())) {
        Js::Obj(entries) => {
            entries.insert(key.to_string(), value);
        }
        other => *other = Js::Obj(obj! { key => value }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A two-level workspace as a walk sees it: the root's bases, each
    /// base's tables, each table its fields. A record of every hop asked.
    struct Workspace {
        asked: RefCell<Vec<String>>,
    }

    impl Walk for Workspace {
        async fn edges_from(&self, position: &Js, _: Option<&Js>) -> Result<Js, String> {
            let kind = position.get("recordType").and_then(Js::as_str).unwrap_or_default().to_string();
            let id = position.get("identity").and_then(|i| i.get("recordId")).and_then(Js::as_str).unwrap_or_default().to_string();
            self.asked.borrow_mut().push(format!("{kind}:{id}"));
            let member = |kind: &str, id: &str, name: &str| {
                Js::Obj(obj! { "adapterType" => Js::str("at"), "recordType" => Js::str(kind), "identity" => Js::Obj(obj! { "kind" => Js::str("stable"), "recordId" => Js::str(id), "data" => Js::Obj(obj! { "Name" => Js::str(name), "Id" => Js::str(id) }) }) })
            };
            Ok(match (kind.as_str(), id.as_str()) {
                ("meta", _) => Js::Obj(obj! {
                    "descriptor" => Js::Obj(obj! { "typeId" => Js::str("meta"), "displayName" => Js::str("meta"), "fields" => Js::Arr(vec![]), "references" => Js::Arr(vec![]) }),
                    "targetPositions" => Js::Obj(obj! { "appA" => member("Base", "appA", "Hiring") }),
                }),
                ("Base", "appA") => Js::Obj(obj! {
                    "descriptor" => Js::Obj(obj! { "typeId" => Js::str("Hiring"), "displayName" => Js::str("Hiring"), "fields" => Js::Arr(vec![]), "references" => Js::Arr(vec![]) }),
                    "targetPositions" => Js::Obj(obj! { "tblC" => member("Table", "tblC", "Candidates"), "tblR" => member("Table", "tblR", "Roles") }),
                }),
                ("Table", "tblC") => Js::Obj(obj! {
                    "descriptor" => Js::Obj(obj! {
                        "typeId" => Js::str("Candidates"),
                        "displayName" => Js::str("Candidates"),
                        "fields" => Js::Arr(vec![Js::Obj(obj! { "fieldId" => Js::str("fldStage"), "displayName" => Js::str("Stage"), "kind" => Js::str("enum"), "enumValues" => Js::strings(["Applied", "Interview"]) })]),
                        "references" => Js::Arr(vec![]),
                    }),
                }),
                _ => Js::Null,
            })
        }
    }

    fn hops() -> Vec<AddressHop> {
        ["base:Base", "table:Table"]
            .iter()
            .map(|s| {
                let (key, collection) = s.split_once(':').unwrap();
                AddressHop { key: key.into(), collection: collection.into(), match_field: "Id".into() }
            })
            .collect()
    }

    /// The event node as a projection mints it: two edges onto the
    /// unnarrowed `Table`, one of them only while the record lives.
    fn schema() -> Js {
        Js::parse(
            br#"{"positions":{
                "Record Change":{"properties":{"action":{"kind":"enum","options":["record.updated","record.deleted"]},"Changed Fields":{"kind":"list","of":"text"}},
                  "edges":{"Record":{"target":"Table","requiresLiveRecord":true},"Old Record":{"target":"Table"},"Other":{"target":"Elsewhere"}}},
                "Table":{"properties":{},"edges":{},"undescribed":true}},
              "collections":{},"eventPositions":[{"position":"Record Change"}]}"#,
        )
        .unwrap()
    }

    fn address(pins: &[(&str, &str)]) -> EventAddress {
        EventAddress { event: "Record Change".into(), narrowing: pins.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    async fn narrowed(hops: &[AddressHop], addresses: &[EventAddress]) -> (Js, Vec<String>) {
        let walk = Workspace { asked: RefCell::new(Vec::new()) };
        let schema = narrow_event_positions(schema(), &Narrowing { adapter: "at", adapter_type: "at", hops, addresses, entries: &[], walk: &walk }).await;
        (schema, walk.asked.into_inner())
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
    }

    #[test]
    fn an_address_retargets_each_edge_onto_the_table_at_the_table_it_walks_to() {
        let (schema, asked) = block_on(narrowed(&hops(), &[address(&[("base", "appA"), ("table", "tblC"), ("action", "record.updated")])]));
        let key = r#"["Record Change",[["action","record.updated"],["base","appA"],["table","tblC"]]]"#;
        let position = schema.get("positions").and_then(|p| p.get(key)).expect("the address is grafted");
        let record_key = r#"at::record::[{"type":"edge","edgeTypeId":"Base","expressionFilter":{"type":"compare","op":"eq","left":{"type":"property","propertyTypeId":"Id"},"right":{"type":"static","value":"appA"}}},{"type":"edge","edgeTypeId":"Table","expressionFilter":{"type":"compare","op":"eq","left":{"type":"property","propertyTypeId":"Id"},"right":{"type":"static","value":"tblC"}}}]"#;
        let target = |edge: &str| position.get("edges").and_then(|e| e.get(edge)).and_then(|e| e.get("target")).and_then(Js::as_str).map(str::to_string);
        assert_eq!(target("Record").as_deref(), Some(record_key));
        assert_eq!(target("Old Record").as_deref(), Some(record_key));
        assert_eq!(target("Other").as_deref(), Some("Elsewhere"), "an edge onto anything else is left");
        assert_eq!(position.get("displayName").and_then(Js::as_str), Some("Record Change where action=record.updated, base=appA, table=tblC"));
        let table = schema.get("positions").and_then(|p| p.get(record_key)).expect("the walked table is a position");
        assert_eq!(table.get("displayName").and_then(Js::as_str), Some("Candidates"));
        assert_eq!(table.get("properties").and_then(|p| p.get("Stage")).map(Js::to_json).as_deref(), Some(r#"{"kind":"enum","options":["Applied","Interview"]}"#));
        assert_eq!(schema.get("positions").and_then(|p| p.get("Record Change")).and_then(|p| p.get("edges")).and_then(|e| e.get("Record")).and_then(|e| e.get("target")).and_then(Js::as_str), Some("Table"), "the event node itself is left");
        // Each hop once: the root, the base, the table.
        assert_eq!(asked, ["meta:", "Base:appA", "Table:tblC"]);
        assert_eq!(
            schema.get("eventNarrowingValues").map(Js::to_json).as_deref(),
            Some(r#"{"[]":{"base":["appA"]},"[[\"base\",\"appA\"]]":{"table":["tblC","tblR"]}}"#)
        );
    }

    #[test]
    fn an_address_that_leaves_the_action_open_is_a_union_of_one_per_action_and_a_deleted_one_has_no_live_record() {
        let (schema, _) = block_on(narrowed(&hops(), &[address(&[("base", "appA"), ("table", "tblC")])]));
        let key = r#"["Record Change",[["base","appA"],["table","tblC"]]]"#;
        let variants = schema.get("unions").and_then(|u| u.get(key)).and_then(Js::as_array).expect("a union");
        assert_eq!(variants.len(), 2);
        let deleted = schema.get("positions").and_then(|p| p.get(r#"["Record Change",[["action","record.deleted"],["base","appA"],["table","tblC"]]]"#)).unwrap();
        assert!(deleted.get("edges").and_then(|e| e.get("Record")).is_none());
        assert!(deleted.get("edges").and_then(|e| e.get("Old Record")).is_some());
        assert_eq!(schema.get("unionDisplayNames").and_then(|u| u.get(key)).and_then(Js::as_str), Some("Record Change where base=appA, table=tblC"));
    }

    #[test]
    fn an_address_that_pins_nothing_is_the_wide_type_and_grafts_nothing() {
        let (schema, asked) = block_on(narrowed(&hops(), &[address(&[])]));
        assert_eq!(schema.get("positions").and_then(|p| match p {
            Js::Obj(map) => Some(map.len()),
            _ => None,
        }), Some(2));
        assert!(schema.get("unions").is_none(), "no union by action: the event node keeps its live-record edges");
        assert!(!asked.iter().any(|a| a.starts_with("Table:")), "nothing walked to a table");
    }

    #[test]
    fn an_address_that_walks_nowhere_or_pins_a_key_no_hop_declares_grafts_nothing() {
        for pins in [&[("base", "appA"), ("table", "tblNONE")][..], &[("base", "appA"), ("colour", "red")][..], &[("base", "appA")][..]] {
            let (schema, _) = block_on(narrowed(&hops(), &[address(pins)]));
            let positions = schema.get("positions").and_then(|p| match p {
                Js::Obj(map) => Some(map.len()),
                _ => None,
            });
            assert_eq!(positions, Some(2), "{pins:?}");
            assert!(schema.get("unions").is_none(), "{pins:?}");
        }
    }

    #[test]
    fn a_position_consumes_the_leading_hops_it_pins() {
        let listen = Js::parse(br#"{"listenConfig":[{"key":"base","narrows":{"collection":"Base","matchField":"Id"}},{"key":"table","narrows":{"collection":"Table","matchField":"Id"}},{"key":"field","format":"field"}]}"#).unwrap();
        let Js::Obj(listen) = listen else { unreachable!() };
        let keys = |values: &[(&str, &str)]| -> Vec<String> {
            address_hops(&listen, &values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()).into_iter().map(|h| h.key).collect()
        };
        assert_eq!(keys(&[]), ["base", "table"]);
        assert_eq!(keys(&[("base", "Hiring")]), ["table"]);
        assert_eq!(keys(&[("table", "x")]), ["base", "table"], "only a leading hop is consumed");
    }

    #[test]
    fn the_addresses_are_the_signatures_against_a_construction() {
        let source = "import { `@lf/airtable` as airtable } from adapters\nimport { acme } from credentials\n\nhiring = connect airtable using acme { base: \"Hiring\" }\n\nfunction f(change: <hiring-[:`Record Change` WHERE `table` == \"tblC\"]->>) {\n  return 1\n}\n\nfunction g(change: <hiring-[:`Record Change`]->>) {\n  return 1\n}\n";
        let program = crate::check::parse(source).map_err(|e| e.message).unwrap();
        let originals: BTreeMap<String, String> = [("airtable".to_string(), "@lf/airtable".to_string())].into_iter().collect();
        let addresses = signature_addresses(&program.statements, &originals);
        assert_eq!(addresses.len(), 2);
        assert_eq!(addresses[0].construction.adapter, "@lf/airtable");
        assert_eq!(addresses[0].construction.credential.as_deref(), Some("acme"));
        assert_eq!(addresses[0].address, address(&[("table", "tblC")]));
        assert_eq!(addresses[1].address, address(&[]));
    }
}
