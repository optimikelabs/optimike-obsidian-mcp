import { z } from "zod";
import { mcpSchema } from "../mcpSchema.js";

/** Shared wire/client contracts have no runtime configuration side effects.
 * Operator clients must not boot the server environment merely to validate a
 * response from an independently running server.
 */
const Entry = z.object({
  uri: z.string(), frontmatter: z.record(z.unknown()),
  resources: z.array(z.object({ uri: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), size: z.number().int().nonnegative() })),
});
const fresh = { resultType: z.literal("complete"), ttlMs: z.literal(0), cacheScope: z.literal("private") };
const ListResult = z.object({ ...fresh, skills: z.array(Entry), nextCursor: z.string().optional() });
const GetResult = z.object({ ...fresh, skill: Entry });
export const ListSkillsResultSchema = mcpSchema(ListResult);
export const GetSkillResultSchema = mcpSchema(GetResult);
// SDK v2 removes the wire result discriminator from its public client view.
export const ListSkillsClientResultSchema = mcpSchema(ListResult.omit({ resultType: true }));
export const GetSkillClientResultSchema = mcpSchema(GetResult.omit({ resultType: true }));
