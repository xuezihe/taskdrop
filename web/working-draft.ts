import { z } from "zod";

export const editSurfaceSchema = z.enum(["human", "webmcp"]);
export type EditSurface = z.infer<typeof editSurfaceSchema>;

export const workingDraftSchema = z
  .object({
    handoffCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/),
    baseRevision: z.number().int().positive().refine(Number.isSafeInteger),
    markdown: z.string(),
    lastModifiedVia: editSurfaceSchema,
    contributors: z.array(editSurfaceSchema),
    updatedAt: z.string().datetime({ offset: false }),
  })
  .strict()
  .refine((draft) => new Set(draft.contributors).size === draft.contributors.length, {
    message: "Working Draft contributors must be unique",
  });

export type WorkingDraft = z.infer<typeof workingDraftSchema>;

export interface CommittedRevision {
  code: string;
  revision: number;
  markdown: string;
}

export function createWorkingDraft(
  committed: CommittedRevision,
  markdown: string,
  surface: EditSurface,
  updatedAt: string,
): WorkingDraft {
  return {
    handoffCode: committed.code,
    baseRevision: committed.revision,
    markdown,
    lastModifiedVia: surface,
    contributors: [surface],
    updatedAt,
  };
}

export function updateWorkingDraft(
  draft: WorkingDraft,
  markdown: string,
  surface: EditSurface,
  updatedAt: string,
): WorkingDraft {
  return {
    ...draft,
    markdown,
    lastModifiedVia: surface,
    contributors: draft.contributors.includes(surface)
      ? draft.contributors
      : [...draft.contributors, surface],
    updatedAt,
  };
}
