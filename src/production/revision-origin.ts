import { z } from "zod";

export const REVISION_ORIGINS = ["mcp", "human", "webmcp"] as const;

export const revisionOriginSchema = z.enum(REVISION_ORIGINS);

export type RevisionOrigin = z.infer<typeof revisionOriginSchema>;
