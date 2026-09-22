import {
  isJSONRPCRequest,
  PROTOCOL_VERSION_META_KEY,
  UnsupportedProtocolVersionError,
  type McpServerFactory,
  type ProtocolEra,
  type Transport,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

/**
 * SDK 2.0.0 validates the opening stdio revision and subsequent envelopes, but
 * only subscriptions/listen rechecks whether later revisions are supported.
 * This public transport adapter closes that pre-dispatch gap on modern-pinned
 * connections. The SDK still owns framing, era selection, discovery, request
 * contexts, validation, subscriptions and serving. Legacy frames are unchanged.
 */
export function serveDualStdio(
  factory: McpServerFactory,
  onerror: (error: Error) => void,
): StdioServerHandle {
  const wire = new StdioServerTransport();
  let era: ProtocolEra | undefined;
  const transport: Transport = {
    start: () => wire.start(),
    close: () => wire.close(),
    send: (message) => wire.send(message),
  };
  wire.onclose = () => transport.onclose?.();
  wire.onerror = (error) => transport.onerror?.(error);
  wire.onmessage = (message) => {
    if (era === "modern" && isJSONRPCRequest(message)) {
      const claimed = message.params?._meta?.[PROTOCOL_VERSION_META_KEY];
      if (typeof claimed === "string" && claimed !== "2026-07-28") {
        const error = new UnsupportedProtocolVersionError({
          supported: ["2026-07-28"],
          requested: /^\d{4}-\d{2}-\d{2}$/.test(claimed) ? claimed : "unknown",
        });
        void wire
          .send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: error.code,
              message: error.message,
              data: error.data,
            },
          })
          .catch((error) =>
            transport.onerror?.(
              error instanceof Error
                ? error
                : new Error("Stdio version rejection failed."),
            ),
          );
        return;
      }
    }
    transport.onmessage?.(message);
  };
  return serveStdio(
    (context) => {
      era = context.era;
      return factory(context);
    },
    { transport, onerror },
  );
}
