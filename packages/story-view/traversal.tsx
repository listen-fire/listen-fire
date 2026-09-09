"use client";

import { createContext, Fragment, useContext } from "react";
import type { StoryView } from "./view";

import { BOX } from "./canvas-style";
import { RawExpression, ValueChip } from "./chips";
import { Alias } from "./referents";
import { TESTS } from "./tests";

/**
 * A traversal, written out as a sentence.
 *
 * The script's own form for this is `chat-[ch:Channels WHERE \`Name\` ==
 * "dealflow"]->`, which says nothing to anyone who does not know the language.
 * So it never reaches this file as text: the story sends the hops, the story
 * view resolves what each one lands on, and the words below are the only thing
 * added — "for each", "named", "where". No name here is a system's; every one
 * of them was declared by the system that owns it.
 *
 * A filter that is a run of straightforward comparisons reads as clauses. One
 * that is anything else is shown WHOLE, as the test the author wrote, inside
 * the same sentence — simplifying it would be the page saying something the
 * script does not.
 *
 */

type Traversal = StoryView["traversals"][number];
type Hop = Traversal["hops"][number];
type Filter = NonNullable<Hop["filter"]>;
type Comparison = Extract<Filter, { kind: "comparisons" }>["all"][number];

/** The resolved traversals of the story being drawn, by id — the same lookup a
 *  write does for its record. */
export const Traversals = createContext<Map<string, Traversal>>(new Map());

export function traversalsOf(view: StoryView): Map<string, Traversal> {
  return new Map(view.traversals.map((traversal) => [traversal.id, traversal]));
}

export function TraversalHeading({
  id,
  lead,
}: {
  id: string;
  /**
   * The OPENING phrase, where the caller knows something about this walk that
   * the walk itself cannot say — a race receipt is a branch of the race above
   * it, and reads as the condition it is ("If time ran out"), not as a thing
   * that came back. Absent ⇒ the walk speaks for itself, as it always has.
   *
   */
  lead?: React.ReactNode;
}) {
  const traversal = useContext(Traversals).get(id);
  if (!traversal) return <>For each of these</>;

  // Nothing came back with any structure — the script could not be read this
  // far. Showing what was written is the honest answer; a sentence would be
  // made up.
  const [first, ...rest] = traversal.hops;
  if (!first) {
    return (
      <>
        For each{" "}
        <span
          title="This part of the script could not be read"
          className={`border border-amber-300 bg-amber-50 px-1.5 py-[1px] font-mono text-[11px] text-amber-800 ${BOX}`}
        >
          {traversal.source}
        </span>
      </>
    );
  }

  return (
    <>
      {lead ?? (
        traversal.from === "result" ? (
          <>With the {carried(first)} that came back</>
        ) : (
          <>For each {subject(first)}</>
        )
      )}
      <Alias name={first.binding} />
      <Clause filter={first.filter} />
      <Tail hops={rest} />
    </>
  );
}

/**
 * A FOLD over a walk — `FIRST(chat-[:Channels WHERE …]->)` — as one sentence.
 *
 * The walk composes exactly as a block head does, out of the same landings and
 * the same declared labels; the fold contributes one word, and that word is
 * this page's own English for one of the language's own functions (see
 * {@link FOLDS}). A fold nobody here has a word for, or a walk with no
 * structure behind it, is shown as the author wrote it — the honest fallback
 * every composed phrase on this canvas falls back to.
 *
 */
export function WalkFold({ fn, id, source }: { fn: string; id: string; source: string }) {
  const traversal = useContext(Traversals).get(id);
  const word = FOLDS[fn];
  const [first, ...rest] = traversal?.hops ?? [];
  if (word === undefined || !first) return <RawExpression source={source} />;
  return (
    <>
      {word} {subject(first)}
      <Clause filter={first.filter} />
      <Tail hops={rest} />
    </>
  );
}

/**
 * What a fold MEANS, as a person would say it. The language's own function id
 * travels and nothing else — the words for it are this page's, exactly as a
 * comparison operator's already are (see `TESTS`).
 *
 * Only the folds that pick ONE landing are here. A fold that answers about the
 * SET (how many, joined together) would need the subject said of many, and this
 * page does not have that word for a system's own label; showing the author's
 * own call is better than a phrase whose number is wrong.
 */
const FOLDS: Record<string, string> = {
  only: "the one",
  first: "the first",
  last: "the last",
};

/** The hops after the first — the walk carrying on. */
function Tail({ hops }: { hops: Hop[] }) {
  return (
    <>
      {hops.map((hop, index) => (
        <Fragment key={index}>
          , then each {subject(hop)}
          <Alias name={hop.binding} />
          <Clause filter={hop.filter} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * What the system calls what this hop reaches. Where it named nothing, the
 * relationship's own name is the closest thing to a name there is — the same
 * fallback a record card makes, and for the same reason: a word nobody declared
 * would be one this page made up.
 */
function subject(hop: Hop): string {
  return hop.label ?? hop.edge;
}

/** Carrying on from an earlier step, the natural word is what the author called
 *  the thing they were waiting for — not what it turned out to land on. */
function carried(hop: Hop): string {
  return hop.edge;
}

function Clause({ filter }: { filter?: Filter }) {
  if (!filter) return null;
  if (filter.kind === "expression") {
    return (
      <>
        {" "}
        where <ValueChip chip={filter.chip} title="The test this has to pass" />
      </>
    );
  }
  const only = filter.all.length === 1 ? filter.all[0] : undefined;
  // "named X" is how anyone would say it, and it is only ever said where the
  // system's own word for the field is the word for a name.
  if (only && only.operator === "eq" && isNameField(only.field)) {
    return (
      <>
        {" "}
        named <ValueChip chip={only.value} />
      </>
    );
  }
  return (
    <>
      {" where "}
      {filter.all.map((comparison, index) => (
        <Fragment key={index}>
          {index > 0 && " and "}
          <Test comparison={comparison} />
        </Fragment>
      ))}
    </>
  );
}

function Test({ comparison }: { comparison: Comparison }) {
  const { verb, reads } = TESTS[comparison.operator];
  return (
    <>
      {comparison.field} {verb}
      {reads && (
        <>
          {" "}
          <ValueChip chip={comparison.value} />
        </>
      )}
    </>
  );
}

function isNameField(field: string): boolean {
  return field.trim().toLowerCase() === "name";
}
