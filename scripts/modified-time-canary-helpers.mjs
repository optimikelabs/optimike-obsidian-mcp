const LOCAL_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;
const PLUGIN_FRESHNESS_MARGIN_MS = 5_200;

export function supportsModifiedTimeSettlementBridgeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value ?? "");
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major > 0 || (major === 0 && minor >= 3);
}

export function assertAtomicNoteCanaryDateIsolation(status) {
  const settlementIntegrations =
    status?.settlement?.modifiedTimeFrontmatter?.integrations ?? [];
  const protection = status?.protection?.frontmatterDateProperties;
  const protectionIntegrations = protection?.integrations ?? [];
  const unsupportedIntegrations = protection?.unsupportedIntegrations ?? [];
  const active = new Set();

  if (Array.isArray(settlementIntegrations)) {
    for (const integration of settlementIntegrations) {
      active.add(
        `${integration?.pluginId ?? "unknown"}:${integration?.propertyName ?? "unknown"}`,
      );
    }
  }
  if (Array.isArray(protectionIntegrations)) {
    for (const integration of protectionIntegrations) {
      if (integration?.modifiedPropertyName) {
        active.add(
          `${integration?.pluginId ?? "unknown"}:${integration.modifiedPropertyName}`,
        );
      }
    }
  }
  if (Array.isArray(unsupportedIntegrations)) {
    for (const integration of unsupportedIntegrations) {
      if (integration?.activeRoles?.includes("modified")) {
        active.add(`${integration?.pluginId ?? "unknown"}:modified(unsupported)`);
      }
    }
  }

  if (active.size === 0) return;
  throw new Error(
    `The byte-exact atomic-note canary requires active modified-time integrations to be disabled before mutation (${[...active].join(", ")}). Run smoke:modified-time-settlement-live separately with the integration enabled.`,
  );
}

export function isSafeModifiedTimePropertyName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[,\r\n:]/u.test(value) &&
    !/^(?:null|true|false|yes|no|on|off)$/iu.test(value) &&
    /^[\p{L}_](?:[\p{L}\p{M}\p{N}_. -]*[\p{L}\p{M}\p{N}_.-])?$/u.test(value)
  );
}

function lineWithoutCarriageReturn(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function modifiedTimeFrontmatterPropertyValue(content, propertyName) {
  const lines = content.split("\n");
  if (lineWithoutCarriageReturn(lines[0] ?? "") !== "---") {
    throw new Error("The canary note must start with standard frontmatter.");
  }
  const closingDelimiter = lines.findIndex(
    (line, index) => index > 0 && lineWithoutCarriageReturn(line) === "---",
  );
  if (closingDelimiter < 0) {
    throw new Error("The canary note frontmatter is not closed.");
  }
  const prefix = `${propertyName}:`;
  const matches = lines
    .slice(1, closingDelimiter)
    .map(lineWithoutCarriageReturn)
    .filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(
      `The canary note must contain exactly one top-level ${propertyName} frontmatter property.`,
    );
  }
  const value = matches[0].slice(prefix.length).trim();
  if (!value) {
    throw new Error(
      `The canary note ${propertyName} property must be non-empty.`,
    );
  }
  return value;
}

export function nextRepresentableTimestampReadyAt(
  currentValue,
  utcOffsetMinutes,
) {
  const match = LOCAL_DATETIME.exec(currentValue);
  if (!match) {
    throw new Error(
      "The current modified-time value must use one supported local datetime format.",
    );
  }
  if (
    !Number.isInteger(utcOffsetMinutes) ||
    utcOffsetMinutes < -14 * 60 ||
    utcOffsetMinutes > 14 * 60
  ) {
    throw new Error("The Obsidian UTC offset is invalid.");
  }
  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second ?? "0"].map(Number);
  const [yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] =
    parts;
  const localEpochMs = Date.UTC(
    yearValue,
    monthValue - 1,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
  );
  const candidate = new Date(localEpochMs);
  if (
    candidate.getUTCFullYear() !== yearValue ||
    candidate.getUTCMonth() !== monthValue - 1 ||
    candidate.getUTCDate() !== dayValue ||
    candidate.getUTCHours() !== hourValue ||
    candidate.getUTCMinutes() !== minuteValue ||
    candidate.getUTCSeconds() !== secondValue
  ) {
    throw new Error("The current modified-time value is not a real datetime.");
  }
  const currentEpochMs = localEpochMs - utcOffsetMinutes * 60_000;
  const representableTickMs = second === undefined ? 60_000 : 1_000;
  return currentEpochMs + representableTickMs + PLUGIN_FRESHNESS_MARGIN_MS;
}
