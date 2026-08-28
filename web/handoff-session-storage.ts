import {
  deriveSpaceId,
  isCanonicalSpaceKey,
  parseSpaceKey,
} from "../src/production/space-identity.js";

import { workingDraftSchema, type WorkingDraft } from "./working-draft.js";

export const SPACE_KEY_STORAGE_KEY = "taskdrop:spaceKey";

export function getStoredSpaceKey(storage: Storage): string | null {
  let value: string | null;
  try {
    value = storage.getItem(SPACE_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (value === null || !isCanonicalSpaceKey(value)) return null;
  return value;
}

export function setStoredSpaceKey(storage: Storage, spaceKey: string): void {
  if (!isCanonicalSpaceKey(spaceKey)) throw new Error("invalid Space Key");
  storage.setItem(SPACE_KEY_STORAGE_KEY, spaceKey);
}

export async function deriveLocalSpaceId(spaceKey: string): Promise<string> {
  const spaceId = await deriveSpaceId(parseSpaceKey(spaceKey));
  return Array.from(spaceId, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function workingDraftStorageKey(localSpaceId: string, handoffCode: string): string {
  return `taskdrop:draft:${localSpaceId}:${handoffCode}`;
}

export interface WorkingDraftStorage {
  load(localSpaceId: string, handoffCode: string): WorkingDraft | null;
  save(localSpaceId: string, handoffCode: string, draft: WorkingDraft): void;
  remove(localSpaceId: string, handoffCode: string): void;
}

export function createSessionWorkingDraftStorage(storage: Storage): WorkingDraftStorage {
  return {
    load(localSpaceId, handoffCode): WorkingDraft | null {
      let serialized: string | null;
      try {
        serialized = storage.getItem(workingDraftStorageKey(localSpaceId, handoffCode));
      } catch {
        return null;
      }
      if (serialized === null) return null;

      try {
        const parsed: unknown = JSON.parse(serialized);
        const result = workingDraftSchema.safeParse(parsed);
        return result.success && result.data.handoffCode === handoffCode ? result.data : null;
      } catch {
        return null;
      }
    },

    save(localSpaceId, handoffCode, draft): void {
      storage.setItem(
        workingDraftStorageKey(localSpaceId, handoffCode),
        JSON.stringify(workingDraftSchema.parse(draft)),
      );
    },

    remove(localSpaceId, handoffCode): void {
      storage.removeItem(workingDraftStorageKey(localSpaceId, handoffCode));
    },
  };
}
