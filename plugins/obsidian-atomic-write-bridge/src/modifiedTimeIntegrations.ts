export type ModifiedTimeIntegration = {
  pluginId: "update-time-on-edit" | "frontmatter-date-manager" | "update-time";
  propertyName: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function loadedPlugin(app: unknown, pluginId: string): unknown {
  const plugins = record(record(app)?.plugins);
  const loaded = record(plugins?.plugins)?.[pluginId];
  const getPlugin = plugins?.getPlugin;
  return (
    loaded ??
    (typeof getPlugin === "function"
      ? getPlugin.call(plugins, pluginId)
      : undefined)
  );
}

function safePropertyName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\r\n:]/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function canonicalStringDatetime(settings: Record<string, unknown>): boolean {
  return (
    (settings.dateFormat === "yyyy-MM-dd'T'HH:mm" ||
      settings.dateFormat === "yyyy-MM-dd'T'HH:mm:ss") &&
    settings.enableNumberProperties !== true
  );
}

export function getModifiedTimeIntegrations(
  app: unknown,
): ModifiedTimeIntegration[] {
  const definitions = [
    {
      pluginId: "update-time-on-edit" as const,
      settingName: "headerUpdated",
      active: canonicalStringDatetime,
    },
    {
      pluginId: "frontmatter-date-manager" as const,
      settingName: "headerUpdated",
      active: (settings: Record<string, unknown>) =>
        settings.enableAutoUpdate === true &&
        settings.enableModifiedTime !== false &&
        canonicalStringDatetime(settings) &&
        (settings.timezone === undefined || settings.timezone === ""),
    },
    {
      pluginId: "update-time" as const,
      settingName: "updatedPropertyName",
      active: () => true,
    },
  ];
  const seen = new Set<string>();
  const integrations: ModifiedTimeIntegration[] = [];
  for (const definition of definitions) {
    const plugin = record(loadedPlugin(app, definition.pluginId));
    const settings = record(plugin?.settings);
    if (!settings || !definition.active(settings)) continue;
    const propertyName = safePropertyName(settings[definition.settingName]);
    if (!propertyName || seen.has(propertyName)) continue;
    seen.add(propertyName);
    integrations.push({ pluginId: definition.pluginId, propertyName });
  }
  return integrations;
}
