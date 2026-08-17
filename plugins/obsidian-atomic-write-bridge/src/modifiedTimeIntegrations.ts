export type ModifiedTimeIntegration = {
  pluginId: "update-time-on-edit" | "frontmatter-date-manager" | "update-time";
  propertyName: string;
  settlementObservationDelayMs: number;
};

export type FrontmatterDateIntegration = {
  pluginId: ModifiedTimeIntegration["pluginId"];
  createdPropertyName?: string;
  modifiedPropertyName?: string;
  viewedPropertyName?: string;
};

export type FrontmatterDateRole = "created" | "modified" | "viewed";

export type UnsupportedFrontmatterDateIntegration = {
  pluginId: ModifiedTimeIntegration["pluginId"];
  activeRoles: FrontmatterDateRole[];
};

export type FrontmatterDateIntegrationContract = {
  protectionIntegrations: FrontmatterDateIntegration[];
  settlementIntegrations: ModifiedTimeIntegration[];
  unsupportedIntegrations: UnsupportedFrontmatterDateIntegration[];
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
    /[,\r\n:]/u.test(value) ||
    /^(?:null|true|false|yes|no|on|off)$/iu.test(value) ||
    !/^[\p{L}_](?:[\p{L}\p{M}\p{N}_. -]*[\p{L}\p{M}\p{N}_.-])?$/u.test(value)
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

type IntegrationDefinition = {
  pluginId: ModifiedTimeIntegration["pluginId"];
  createdSettingName: string;
  modifiedSettingName: string;
  viewedSettingName?: string;
  createdFallback?: string;
  modifiedFallback?: string;
  viewedFallback?: string;
  createdActive: (settings: Record<string, unknown>) => boolean;
  modifiedActive: (settings: Record<string, unknown>) => boolean;
  viewedActive?: (settings: Record<string, unknown>) => boolean;
  settlementActive: (settings: Record<string, unknown>) => boolean;
  settlementObservationDelayMs: (
    settings: Record<string, unknown>,
  ) => number | undefined;
};

const MAX_SUPPORTED_SETTLEMENT_DELAY_MS = 4 * 60 * 1000;

function boundedDelay(value: unknown, fallback: number): number | undefined {
  const delay = typeof value === "number" ? value : fallback;
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  const rounded = Math.ceil(delay);
  return rounded <= MAX_SUPPORTED_SETTLEMENT_DELAY_MS ? rounded : undefined;
}

const DEFINITIONS: readonly IntegrationDefinition[] = [
  {
    pluginId: "update-time-on-edit",
    createdSettingName: "headerCreated",
    modifiedSettingName: "headerUpdated",
    createdActive: (settings) => settings.enableCreateTime !== false,
    modifiedActive: () => true,
    settlementActive: canonicalStringDatetime,
    settlementObservationDelayMs: () => 250,
  },
  {
    pluginId: "frontmatter-date-manager",
    createdSettingName: "headerCreated",
    modifiedSettingName: "headerUpdated",
    viewedSettingName: "headerLastViewed",
    viewedFallback: "viewed",
    createdActive: (settings) =>
      settings.enableAutoUpdate === true && settings.enableCreateTime === true,
    modifiedActive: (settings) =>
      settings.enableAutoUpdate === true &&
      settings.enableModifiedTime !== false,
    viewedActive: (settings) =>
      settings.enableAutoUpdate === true && settings.enableLastViewed === true,
    settlementActive: (settings) =>
      canonicalStringDatetime(settings) &&
      (settings.timezone === undefined || settings.timezone === "") &&
      settings.countUpdatesEnabled !== true &&
      (settings.postUpdateCommand === undefined ||
        settings.postUpdateCommand === "") &&
      (settings.inversionFixStrategy === undefined ||
        settings.inversionFixStrategy === "disabled"),
    settlementObservationDelayMs: (settings) => {
      const minimumSeconds = boundedDelay(settings.minSecondsBetweenSaves, 30);
      // FDM 1.2/1.3 combines a 2 s modify debounce with a 5 s freshness
      // window before its configured minimum interval can be observed safely.
      return minimumSeconds === undefined
        ? undefined
        : boundedDelay(7_250 + minimumSeconds * 1_000, 37_250);
    },
  },
  {
    pluginId: "update-time",
    createdSettingName: "createdPropertyName",
    modifiedSettingName: "updatedPropertyName",
    createdFallback: "created",
    modifiedFallback: "updated",
    createdActive: () => true,
    modifiedActive: () => true,
    // Update Time 1.2.1 fixes its format to yyyy-MM-dd'T'HH:mm and writes
    // string properties. There is no format or numeric-type setting to admit.
    settlementActive: () => true,
    settlementObservationDelayMs: (settings) => {
      const saveDelaySeconds = boundedDelay(settings.saveDelayInSeconds, 2);
      return saveDelaySeconds === undefined
        ? undefined
        : boundedDelay(250 + saveDelaySeconds * 1_000, 2_250);
    },
  },
];

function configuredPropertyName(
  settings: Record<string, unknown>,
  settingName: string,
  fallback?: string,
): string | undefined {
  const value = settings[settingName];
  if (fallback !== undefined) {
    if (typeof value !== "string") return safePropertyName(fallback);
    const trimmed = value.trim();
    return safePropertyName(trimmed.length === 0 ? fallback : trimmed);
  }
  return safePropertyName(value);
}

export function getFrontmatterDateIntegrationContract(
  app: unknown,
): FrontmatterDateIntegrationContract {
  const protectionIntegrations: FrontmatterDateIntegration[] = [];
  const settlementIntegrations: ModifiedTimeIntegration[] = [];
  const unsupportedIntegrations: UnsupportedFrontmatterDateIntegration[] = [];
  for (const definition of DEFINITIONS) {
    const plugin = record(loadedPlugin(app, definition.pluginId));
    const settings = record(plugin?.settings);
    if (!settings) continue;
    const createdActive = definition.createdActive(settings);
    const modifiedActive = definition.modifiedActive(settings);
    const viewedActive = Boolean(
      definition.viewedSettingName && definition.viewedActive?.(settings),
    );
    const createdPropertyName = createdActive
      ? configuredPropertyName(
          settings,
          definition.createdSettingName,
          definition.createdFallback,
        )
      : undefined;
    const modifiedPropertyName = modifiedActive
      ? configuredPropertyName(
          settings,
          definition.modifiedSettingName,
          definition.modifiedFallback,
        )
      : undefined;
    const viewedPropertyName =
      definition.viewedSettingName && viewedActive
        ? configuredPropertyName(
            settings,
            definition.viewedSettingName,
            definition.viewedFallback,
          )
        : undefined;

    const activeRoles: FrontmatterDateRole[] = [];
    if (createdActive && !createdPropertyName) activeRoles.push("created");
    if (modifiedActive && !modifiedPropertyName) activeRoles.push("modified");
    if (viewedActive && !viewedPropertyName) activeRoles.push("viewed");
    if (activeRoles.length > 0) {
      unsupportedIntegrations.push({
        pluginId: definition.pluginId,
        activeRoles,
      });
    }

    if (createdPropertyName || modifiedPropertyName || viewedPropertyName) {
      protectionIntegrations.push({
        pluginId: definition.pluginId,
        ...(createdPropertyName ? { createdPropertyName } : {}),
        ...(modifiedPropertyName ? { modifiedPropertyName } : {}),
        ...(viewedPropertyName ? { viewedPropertyName } : {}),
      });
    }

    if (modifiedPropertyName && definition.settlementActive(settings)) {
      const settlementObservationDelayMs =
        definition.settlementObservationDelayMs(settings);
      if (settlementObservationDelayMs !== undefined) {
        settlementIntegrations.push({
          pluginId: definition.pluginId,
          propertyName: modifiedPropertyName,
          settlementObservationDelayMs,
        });
      }
    }
  }
  return {
    protectionIntegrations,
    settlementIntegrations,
    unsupportedIntegrations,
  };
}

export function getFrontmatterDateIntegrations(
  app: unknown,
): FrontmatterDateIntegration[] {
  return getFrontmatterDateIntegrationContract(app).protectionIntegrations;
}

export function getModifiedTimeIntegrations(
  app: unknown,
): ModifiedTimeIntegration[] {
  return getFrontmatterDateIntegrationContract(app).settlementIntegrations;
}
