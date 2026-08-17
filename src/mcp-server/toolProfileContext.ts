import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolProfileId } from "./toolProfiles.js";

const toolProfileContext = new AsyncLocalStorage<ToolProfileId>();

export function currentToolProfileContext(): ToolProfileId | undefined {
  return toolProfileContext.getStore();
}

export function withToolProfileContext<T>(
  profile: ToolProfileId,
  operation: () => Promise<T>,
): Promise<T> {
  return toolProfileContext.run(profile, operation);
}
