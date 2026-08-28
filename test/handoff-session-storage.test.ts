import { describe, expect, it } from "vitest";

import { formatSpaceKey } from "../src/production/space-identity.js";
import {
  createSessionWorkingDraftStorage,
  deriveLocalSpaceId,
  getStoredSpaceKey,
  setStoredSpaceKey,
  workingDraftStorageKey,
} from "../web/handoff-session-storage.js";
import { createWorkingDraft } from "../web/working-draft.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const spaceKey = formatSpaceKey(new Uint8Array(32));
const otherSpaceKey = formatSpaceKey(new Uint8Array(32).fill(1));
const committed = { code: "ABC001", revision: 2, markdown: "# Current" };

describe("browser Space and Working Draft storage", () => {
  it("stores only a canonical Space Key in the session namespace", () => {
    const storage = new MemoryStorage();

    expect(getStoredSpaceKey(storage)).toBeNull();
    setStoredSpaceKey(storage, spaceKey);
    expect(getStoredSpaceKey(storage)).toBe(spaceKey);
    expect(storage.getItem("taskdrop:spaceKey")).toBe(spaceKey);
  });

  it("derives a browser-local Space identity from the same Production derivation", async () => {
    await expect(deriveLocalSpaceId(spaceKey)).resolves.toBe(
      "181d0758ffa73f59cb5ba396e9f057f5256f9c9df754494441cfa8792aaa0fc5",
    );
  });

  it("namespaces Drafts by local Space identity and Handoff Code", async () => {
    const storage = new MemoryStorage();
    const localSpaceId = await deriveLocalSpaceId(spaceKey);
    const otherLocalSpaceId = await deriveLocalSpaceId(otherSpaceKey);
    const drafts = createSessionWorkingDraftStorage(storage);
    const draft = createWorkingDraft(committed, "# Local", "human", "2026-08-28T08:00:00.000Z");

    drafts.save(localSpaceId, committed.code, draft);

    expect(drafts.load(localSpaceId, committed.code)).toEqual(draft);
    expect(drafts.load(otherLocalSpaceId, committed.code)).toBeNull();
    expect(workingDraftStorageKey(localSpaceId, committed.code)).not.toBe(
      workingDraftStorageKey(otherLocalSpaceId, committed.code),
    );
  });

  it("removes only the selected Space and Code Draft", async () => {
    const storage = new MemoryStorage();
    const localSpaceId = await deriveLocalSpaceId(spaceKey);
    const otherLocalSpaceId = await deriveLocalSpaceId(otherSpaceKey);
    const drafts = createSessionWorkingDraftStorage(storage);
    const draft = createWorkingDraft(committed, "# Local", "human", "2026-08-28T08:00:00.000Z");
    const otherDraft = createWorkingDraft(
      committed,
      "# Other",
      "human",
      "2026-08-28T08:00:00.000Z",
    );

    drafts.save(localSpaceId, committed.code, draft);
    drafts.save(otherLocalSpaceId, committed.code, otherDraft);
    drafts.remove(localSpaceId, committed.code);

    expect(drafts.load(localSpaceId, committed.code)).toBeNull();
    expect(drafts.load(otherLocalSpaceId, committed.code)).toEqual(otherDraft);
  });

  it("does not load a Draft whose stored payload names another Handoff", async () => {
    const storage = new MemoryStorage();
    const localSpaceId = await deriveLocalSpaceId(spaceKey);
    const drafts = createSessionWorkingDraftStorage(storage);
    const draft = createWorkingDraft(committed, "# Local", "human", "2026-08-28T08:00:00.000Z");

    storage.setItem(
      workingDraftStorageKey(localSpaceId, committed.code),
      JSON.stringify({ ...draft, handoffCode: "XYZ789" }),
    );

    expect(drafts.load(localSpaceId, committed.code)).toBeNull();
  });
});
