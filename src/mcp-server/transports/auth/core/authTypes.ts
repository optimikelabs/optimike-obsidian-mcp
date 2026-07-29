/**
 * @fileoverview Shared types for authentication middleware.
 * @module src/mcp-server/transports/auth/core/auth.types
 */

import type { AuthInfo as SdkAuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Defines the structure for authentication information derived from a verified token.
 * It extends the base SDK type with claims used to derive a stable, non-reversible
 * client identity for quotas and admission control.
 */
export type AuthInfo = SdkAuthInfo & {
  subject?: string;
  issuer?: string;
};

// Extend the Node.js IncomingMessage type to include an optional 'auth' property.
// This is necessary for type-safe access when attaching the AuthInfo.
declare module "http" {
  interface IncomingMessage {
    auth?: AuthInfo;
  }
}
