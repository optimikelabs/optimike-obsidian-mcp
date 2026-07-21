export const SUPPORTED_TASK_ENGINE_PLUGIN_IDS = ["kairelys", "operon"] as const;

export type SupportedTaskEnginePluginId =
  (typeof SUPPORTED_TASK_ENGINE_PLUGIN_IDS)[number];

export interface TaskEnginePluginHandle {
  id: SupportedTaskEnginePluginId;
  name: string;
  plugin: unknown;
}

interface CommunityPluginManagerLike {
  plugins?: Record<string, unknown>;
  getPlugin?: (id: string) => unknown;
}

function getLoadedPlugin(
  manager: CommunityPluginManagerLike | null | undefined,
  id: SupportedTaskEnginePluginId,
): unknown {
  return manager?.plugins?.[id] ?? manager?.getPlugin?.(id) ?? null;
}

export function resolveTaskEnginePlugin(
  manager: CommunityPluginManagerLike | null | undefined,
): TaskEnginePluginHandle | null {
  const loaded = SUPPORTED_TASK_ENGINE_PLUGIN_IDS.flatMap((id) => {
    const plugin = getLoadedPlugin(manager, id);
    if (!plugin) return [];
    const manifest = (plugin as { manifest?: { name?: unknown } }).manifest;
    const name =
      typeof manifest?.name === "string" && manifest.name.trim()
        ? manifest.name.trim()
        : id === "kairelys"
          ? "Kairélys"
          : "Operon";
    return [{ id, name, plugin }];
  });

  if (loaded.length > 1) {
    throw new Error(
      "Kairélys and Operon are both loaded. Disable one task engine before using the Bridge; mirrored ownership is intentionally unsupported.",
    );
  }
  return loaded[0] ?? null;
}
