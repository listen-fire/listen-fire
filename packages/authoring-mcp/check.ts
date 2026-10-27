// The check every validate, save and edit runs, and what an agent is told of
// it: each diagnostic with its line, the offending source line, and the
// handbook anchor that shows the fix (`readHandbook` serves every one).

import { MovementEngineError } from 'movement-engine/public/embed';
import { collectFileListeners, type FileListener } from 'movement-engine/public/inbound';
import { ENGINE_VERSION, parsePinned, throwIfBlocking } from 'movement-engine/public/movement-engine';
import {
  HANDBOOK_POINTER_BY_CODE,
  LANGUAGE_VERSION,
  MovementParseError,
  checkSourceInRust,
  diagnosticSeverity,
  parseProgram,
  type Diagnostic,
} from 'movement-lang';

import type { CheckRequest, CheckResult } from './host';

/**
 * The package's own checker: this release's parse and the Rust checker,
 * against the tenant's catalog. A save goes live when nothing blocks, by the
 * engine's own rule (`throwIfBlocking`: errors, except the retirements a
 * saved program may still run), the same rule a run is held to.
 */
export async function checkProgram(request: CheckRequest): Promise<CheckResult> {
  const version = LANGUAGE_VERSION;
  try {
    parseProgram(request.source, { languageVersion: version });
  } catch (error) {
    if (!(error instanceof MovementParseError)) throw error;
    return { diagnostics: [{ code: 'MOV_PARSE', message: error.message, span: { start: error.loc, end: error.loc } }], ok: false, version };
  }
  const diagnostics = checkSourceInRust(request.source, request.catalog, { languageVersion: version });
  return { diagnostics, ok: !blocks(diagnostics), version };
}

function blocks(diagnostics: Diagnostic[]): boolean {
  try {
    throwIfBlocking(diagnostics);
    return false;
  } catch (error) {
    if (error instanceof MovementEngineError) return true;
    throw error;
  }
}

/** A diagnostic as an agent reads it: 1-based positions, the line it is on,
 *  and where the handbook shows the fix, when it does. */
export interface AuthoringDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** The offending source line, verbatim. */
  sourceLine: string;
  /** A handbook anchor for readHandbook (`front#maybe-absent`). */
  handbook?: string;
  /** The exact rewrite that resolves it: replace each range with `text`. */
  fix?: { edits: Array<{ line: number; col: number; endLine: number; endCol: number; text: string }>; safe?: true };
}

export function authoringDiagnostics(source: string, diagnostics: readonly Diagnostic[]): AuthoringDiagnostic[] {
  const lines = source.split('\n');
  return diagnostics.map((diagnostic) => {
    const { start, end } = diagnostic.span;
    const anchor = HANDBOOK_POINTER_BY_CODE[diagnostic.code];
    const fix = diagnostic.fix;
    return {
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnosticSeverity(diagnostic),
      line: start.line,
      col: start.col,
      endLine: end.line,
      endCol: end.col,
      sourceLine: lines[start.line - 1] ?? '',
      ...(anchor !== undefined ? { handbook: anchor } : {}),
      ...(fix !== undefined
        ? {
            fix: {
              edits: fix.edits.map((edit) => ({
                line: edit.span.start.line,
                col: edit.span.start.col,
                endLine: edit.span.end.line,
                endCol: edit.span.end.col,
                text: edit.text,
              })),
              ...(fix.safe === true ? { safe: true as const } : {}),
            },
          }
        : {}),
    };
  });
}

/** validateAutomation's answer, which a refused save repeats. */
export interface Validation {
  ok: boolean;
  diagnostics: AuthoringDiagnostic[];
  /** Systems that could not be checked. */
  unverified: string[];
  validatedUnder: { version: string };
}

export function validationOf(source: string, result: CheckResult): Validation {
  return {
    ok: result.ok && (result.unverified ?? []).length === 0,
    diagnostics: authoringDiagnostics(source, result.diagnostics),
    unverified: result.unverified ?? [],
    validatedUnder: { version: result.version },
  };
}

/**
 * What a save answers when the text would not go live: nothing is saved, and
 * the diagnostics come back as validateAutomation gives them, so the save is
 * itself the check. Null when the save may go ahead.
 */
export function unsavedRefusal(result: CheckResult, validation: Validation) {
  const refused = { ok: false as const, saved: false as const, diagnostics: validation.diagnostics, validatedUnder: validation.validatedUnder };
  if (!result.ok) return { ...refused, message: 'Not saved: the program has errors (diagnostics). Fix them and save again.' };
  if (validation.unverified.length > 0) {
    return {
      ...refused,
      message:
        "Not saved: a system it uses could not be checked (errors). Save again once the connection works, or pass acknowledgeErrors: true — with the user's consent — to save it unchecked.",
      errors: validation.unverified,
    };
  }
  return null;
}

/** The listens a text declares; none when it does not parse. */
export function listenersOf(source: string): FileListener[] | null {
  try {
    return collectFileListeners(parsePinned({ source, languageVersion: ENGINE_VERSION }));
  } catch (error) {
    if (error instanceof MovementEngineError) return null;
    throw error;
  }
}
