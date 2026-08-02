/**
 * PROTOTYPE - THROW AWAY.
 *
 * Portable in-memory logic for deciding whether TaskDrop's three-tool Handoff
 * contract is coherent. This module knows nothing about MCP, HTTP, or raw
 * credentials.
 */

import { randomBytes } from "node:crypto";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;

export type HandoffSnapshot = {
  ok: true;
  code: string;
  revision: number;
  latestRevision: number;
  isLatest: boolean;
  markdown: string;
};

export type HandoffFailure =
  | {
      ok: false;
      error: {
        code: "HANDOFF_NOT_FOUND";
        handoffCode: string;
      };
    }
  | {
      ok: false;
      error: {
        code: "REVISION_CONFLICT";
        expectedRevision: number;
        receivedBaseRevision: number;
      };
    };

export type HandoffResult = HandoffSnapshot | HandoffFailure;

type Revision = {
  revision: number;
  markdown: string;
};

type Handoff = {
  code: string;
  revisions: Revision[];
};

export type VisiblePrototypeState = Array<{
  scopeHash: string;
  handoffs: Array<{
    code: string;
    revisions: Array<{ revision: number; markdownLength: number }>;
  }>;
}>;

export class HandoffService {
  readonly #spaces = new Map<string, Map<string, Handoff>>();

  createHandoff(scopeHash: string, markdown: string): HandoffSnapshot {
    const space = this.#space(scopeHash);
    const code = createUniqueCode(space);
    const handoff = {
      code,
      revisions: [{ revision: 1, markdown }],
    };
    space.set(code, handoff);
    return snapshot(handoff, handoff.revisions[0]);
  }

  getHandoff(
    scopeHash: string,
    code: string,
    revision: number | "latest" = "latest",
  ): HandoffResult {
    const normalizedCode = normalizeCode(code);
    const handoff = this.#spaces.get(scopeHash)?.get(normalizedCode);

    if (!handoff) {
      return notFound(normalizedCode);
    }

    const selected =
      revision === "latest"
        ? handoff.revisions.at(-1)
        : handoff.revisions.find((item) => item.revision === revision);

    return selected ? snapshot(handoff, selected) : notFound(normalizedCode);
  }

  appendRevision(
    scopeHash: string,
    code: string,
    baseRevision: number,
    markdown: string,
  ): HandoffResult {
    const normalizedCode = normalizeCode(code);
    const handoff = this.#spaces.get(scopeHash)?.get(normalizedCode);

    if (!handoff) {
      return notFound(normalizedCode);
    }

    const latest = handoff.revisions.at(-1);
    if (!latest) {
      throw new Error("Prototype invariant failed: Handoff has no Revision");
    }

    if (baseRevision !== latest.revision) {
      return {
        ok: false,
        error: {
          code: "REVISION_CONFLICT",
          expectedRevision: latest.revision,
          receivedBaseRevision: baseRevision,
        },
      };
    }

    const next = { revision: latest.revision + 1, markdown };
    handoff.revisions.push(next);
    return snapshot(handoff, next);
  }

  visibleState(): VisiblePrototypeState {
    return [...this.#spaces.entries()].map(([scopeHash, space]) => ({
      scopeHash,
      handoffs: [...space.values()].map((handoff) => ({
        code: handoff.code,
        revisions: handoff.revisions.map((revision) => ({
          revision: revision.revision,
          markdownLength: revision.markdown.length,
        })),
      })),
    }));
  }

  #space(scopeHash: string): Map<string, Handoff> {
    const existing = this.#spaces.get(scopeHash);
    if (existing) {
      return existing;
    }

    const created = new Map<string, Handoff>();
    this.#spaces.set(scopeHash, created);
    return created;
  }
}

function createUniqueCode(space: Map<string, Handoff>): string {
  for (;;) {
    const bytes = randomBytes(CODE_LENGTH);
    let code = "";
    for (const byte of bytes) {
      code += CODE_ALPHABET[byte & 31];
    }
    if (!space.has(code)) {
      return code;
    }
  }
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replaceAll("O", "0").replace(/[IL]/g, "1");
}

function snapshot(handoff: Handoff, revision: Revision | undefined): HandoffSnapshot {
  if (!revision) {
    throw new Error("Prototype invariant failed: missing Revision");
  }

  const latestRevision = handoff.revisions.length;
  return {
    ok: true,
    code: handoff.code,
    revision: revision.revision,
    latestRevision,
    isLatest: revision.revision === latestRevision,
    markdown: revision.markdown,
  };
}

function notFound(code: string): HandoffFailure {
  return {
    ok: false,
    error: { code: "HANDOFF_NOT_FOUND", handoffCode: code },
  };
}
