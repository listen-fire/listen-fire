// The GitHub write surface (v1): a comment on a pull request or an issue, and
// a label added to one. Both are written along the record's own edge, so the
// parent link's data (the payload this adapter minted for the pull request or
// issue) says which repository and number to address — no id crosses the
// program.
//
// Field keys arrive already resolved to this adapter's INTERNAL field ids —
// the adapter translates the author's natural names first.

import type { ParentLink, WriteInput, WriteResult } from 'movement-engine/public/adapter';

import { singleParentLink } from 'movement-engine/public/adapter';
import { normalizeComment, normalizeLabel, type GithubClient } from './api_client';
import {
  GITHUB_ADAPTER_TYPE,
  GITHUB_COMMENT_DISPLAY_NAME,
  GITHUB_COMMENT_TYPE_ID,
  GITHUB_ISSUE_DISPLAY_NAME,
  GITHUB_LABEL_DISPLAY_NAME,
  GITHUB_LABEL_TYPE_ID,
  GITHUB_PULL_REQUEST_DISPLAY_NAME,
  type GithubRepoRef,
} from './types';

/** The types a write can create. */
export type GithubWritableTypeId = typeof GITHUB_COMMENT_TYPE_ID | typeof GITHUB_LABEL_TYPE_ID;

export function writableTypeId(typeId: string): GithubWritableTypeId | undefined {
  switch (typeId) {
    case GITHUB_COMMENT_TYPE_ID:
    case GITHUB_LABEL_TYPE_ID:
      return typeId;
    default:
      return undefined;
  }
}

function unreachable(typeId: never): never {
  throw new Error(`GithubAdapter: unhandled writable type ${String(typeId)}`);
}

/** The pull request or issue a write hangs off, read from the payload this
 *  adapter minted for it. */
function issueOf(write: WriteInput, what: string): GithubRepoRef & { number: number } {
  let parent: ParentLink | undefined;
  try {
    parent = singleParentLink(write);
  } catch {
    parent = undefined;
  }
  const data = parent?.data;
  const onIssueLike = parent?.recordType === GITHUB_PULL_REQUEST_DISPLAY_NAME || parent?.recordType === GITHUB_ISSUE_DISPLAY_NAME;
  if (!onIssueLike || typeof data?.owner !== 'string' || typeof data.repo !== 'string' || typeof data.number !== 'number') {
    throw new Error(
      `GithubAdapter.createRecord: a ${what} is written along one pull request's or issue's edge ` +
        `(write pr-[:${what === 'comment' ? 'Comments' : 'Labels'}]-> { … }), reached from GitHub in this run.`,
    );
  }
  return { owner: data.owner, repo: data.repo, number: data.number };
}

function requiredText(fields: Record<string, unknown>, key: string, name: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`GithubAdapter.createRecord: \`${name}\` is required and must be non-empty text.`);
  }
  return value;
}

export async function createGithubRecord(input: {
  client: GithubClient;
  typeId: GithubWritableTypeId;
  write: WriteInput;
}): Promise<WriteResult> {
  const { client, write } = input;
  switch (input.typeId) {
    case GITHUB_COMMENT_TYPE_ID: {
      const on = issueOf(write, 'comment');
      const comment = normalizeComment(await client.createComment(on, on.number, requiredText(write.fields, 'body', 'Body')));
      return {
        adapterType: GITHUB_ADAPTER_TYPE,
        externalId: comment.id,
        recordType: GITHUB_COMMENT_DISPLAY_NAME,
        url: comment.html_url,
        data: { ...comment },
      };
    }
    case GITHUB_LABEL_TYPE_ID: {
      const on = issueOf(write, 'label');
      const name = requiredText(write.fields, 'name', 'Name').trim();
      const carried = await client.addLabels(on, on.number, [name]);
      // GitHub answers every label the issue now carries; matched by name
      // case-insensitively, as GitHub matches label names.
      const added = carried.find((l) => l.name.toLowerCase() === name.toLowerCase());
      const label = added !== undefined ? normalizeLabel(added) : { id: name, name, color: null, description: null };
      return {
        adapterType: GITHUB_ADAPTER_TYPE,
        externalId: label.id,
        recordType: GITHUB_LABEL_DISPLAY_NAME,
        data: { ...label },
      };
    }
    default:
      return unreachable(input.typeId);
  }
}
