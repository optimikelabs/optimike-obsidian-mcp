import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProtocolError, ProtocolErrorCode, type McpRequestContext, type Server,
  type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { ExternalRootsService } from "../../services/externalRootsService.js";
import { SkillRegistry, SkillRegistryError, isSkillResourceUri, readSkillsPublicationConfig } from "../../services/skills/skillRegistry.js";
import type { ToolProfileId } from "../toolProfiles.js";
import { mcpSchema } from "../mcpSchema.js";
import { activeHttpRequestId } from "../transports/httpRequestState.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
const meta = z.record(z.unknown()).optional();
const ListParams = z.object({ cursor: z.string().max(256).optional(), _meta: meta }).strict().optional().transform(v => v ?? {});
const GetParams = z.object({ uri: z.string().min(1).max(4096), _meta: meta }).strict();
const Entry = z.object({
  uri: z.string(), frontmatter: z.record(z.unknown()),
  resources: z.array(z.object({ uri: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), size: z.number().int().nonnegative() })),
});
const fresh = { resultType: z.literal("complete"), ttlMs: z.literal(0), cacheScope: z.literal("private") };
const ListResult = z.object({ ...fresh, skills: z.array(Entry), nextCursor: z.string().optional() });
const GetResult = z.object({ ...fresh, skill: Entry });
export const ListSkillsResultSchema = mcpSchema(ListResult);
export const GetSkillResultSchema = mcpSchema(GetResult);
// SDK v2 strips resultType from its public client result after decoding the
// modern wire envelope. Keep wire validation distinct from that client view.
export const ListSkillsClientResultSchema = mcpSchema(ListResult.omit({ resultType: true }));
export const GetSkillClientResultSchema = mcpSchema(GetResult.omit({ resultType: true }));

function safeParams<S extends z.ZodTypeAny>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const wrapped = mcpSchema(schema);
  return { "~standard": { ...wrapped["~standard"], validate: async value => {
    const result = await schema.safeParseAsync(value);
    return result.success ? { value: result.data } : { issues: [{ message: "Invalid Skills request parameters." }] };
  } } };
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const invalid = error instanceof SkillRegistryError && error.reason === "cursor_invalid";
    throw new ProtocolError(ProtocolErrorCode.InvalidParams,
      invalid ? "Invalid Skills pagination cursor." : "The requested skill or resource is unavailable.",
      { requestId: activeHttpRequestId() ?? randomUUID() });
  }
}

/** Explicit independent opt-in. Local configuration is not a caller argument.
 * Legacy serving never reads it or advertises the modern-only extension.
 */
export async function configuredSkillRegistry(
  roots: ExternalRootsService | undefined, profile: ToolProfileId, context?: McpRequestContext,
): Promise<SkillRegistry | undefined> {
  const file = process.env.MCP_SKILLS_CONFIG_FILE?.trim();
  if (context?.era !== "modern" || !file) return undefined;
  if (!roots) throw new SkillRegistryError("configuration_invalid");
  return new SkillRegistry(roots, await readSkillsPublicationConfig(file), profile);
}

/** Public SDK extension registration. With an McpServer, install this before
 * its first resource registration and without constructor resources capability;
 * its public registration callback is then wrapped, not its private registry.
 * A low-level proxy has no existing resources and uses standalone mode.
 */
export function installSkillsExtension(
  server: Server, registry: SkillRegistry, options: { deferResourceRead?: boolean } = {},
): void {
  server.registerCapabilities({ resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } });
  server.setRequestHandler("skills/list", { params: safeParams(ListParams), result: ListSkillsResultSchema },
    params => safe(() => registry.list(params.cursor)));
  server.setRequestHandler("skills/get", { params: safeParams(GetParams), result: GetSkillResultSchema },
    params => safe(() => registry.get(params.uri)));

  if (!options.deferResourceRead) {
    server.setRequestHandler("resources/list", async () => ({ ...freshness(), resources: [] }));
    server.setRequestHandler("resources/templates/list", async () => ({ ...freshness(), resourceTemplates: [] }));
    server.setRequestHandler("resources/read", request => safe(() => registry.read(request.params.uri)));
    return;
  }
  server.assertCanSetRequestHandler("resources/read");
  type Callback = (...args: any[]) => any;
  const register = server.setRequestHandler.bind(server) as Callback;
  server.setRequestHandler = ((method: string, ...args: any[]) => {
    if (method !== "resources/read") return register(method, ...args);
    const callback = args.at(-1) as Callback;
    if (typeof callback !== "function") throw new Error("Invalid public resource handler.");
    return register(method, ...args.slice(0, -1), async (request: any, context: any) => safe(async () => {
      const uri = request.params.uri;
      return isSkillResourceUri(uri) ? registry.read(uri) : callback(request, context);
    }));
  }) as typeof server.setRequestHandler;
}
function freshness() { return { resultType: "complete" as const, ttlMs: 0, cacheScope: "private" as const }; }
