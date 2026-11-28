import { setTimeout as delay } from "node:timers/promises";

const retryableReasons = new Set([
  "headless_link_index_building",
  "headless_link_cache_refreshing",
  "headless_link_cache_events_pending",
  "headless_link_cache_uncertain",
]);

/** Wait for the public readiness response under a single deadline. */
export async function readHeadlessNoteLinks(client, filePath, timeoutMs = 60_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  let lastReason = "no response";
  try {
    while (!signal.aborted) {
      const result = await client.callTool(
        { name: "obsidian_note_links", arguments: { filePath } },
        { signal, timeout: timeoutMs },
      );
      const text = result.content?.map((item) => item.text ?? "").join("\n") ?? "";
      let body;
      try {
        body = JSON.parse(text);
      } catch (cause) {
        throw new Error(`obsidian_note_links returned non-JSON for ${filePath} (last status: ${lastReason})`, { cause });
      }
      if (!result.isError && body?.ok === true) return body;
      const error = body?.error;
      if (error?.code !== "SERVICE_UNAVAILABLE" || error.details?.retryable !== true ||
          !retryableReasons.has(error.details.reasonCode)) {
        throw new Error(`obsidian_note_links failed for ${filePath}: ${text}`);
      }
      lastReason = error.details.reasonCode;
      await delay(100, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  throw new Error(`obsidian_note_links did not become ready for ${filePath} within ${timeoutMs}ms (last status: ${lastReason})`);
}
