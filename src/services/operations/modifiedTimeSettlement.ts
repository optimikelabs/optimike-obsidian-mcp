import { createHash } from "node:crypto";

export type ModifiedTimeIntegration = {
  pluginId: "update-time-on-edit" | "frontmatter-date-manager" | "update-time";
  propertyName: string;
};

export type ModifiedTimeSettlementPolicy = {
  contractVersion: 1;
  integrations: ModifiedTimeIntegration[];
  utcOffsetMinutes: number;
};

export type ModifiedTimeSettlementWindow = {
  applyStartedAtEpochMs: number;
  settlementObservedAtEpochMs: number;
};

export type ModifiedTimeSettlementEvidence = {
  contractVersion: 1;
  kind: "modified-time-frontmatter";
  pluginId: ModifiedTimeIntegration["pluginId"];
  propertyName: string;
  observedSha256: string;
  observedAt: string;
};

const STRICT_LOCAL_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;
const MAX_SETTLEMENT_WINDOW_MS = 5 * 60 * 1000;

function validLocalDatetime(value: string): string | undefined {
  const match = STRICT_LOCAL_DATETIME.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] =
    parts;
  const candidate = new Date(
    Date.UTC(
      yearValue,
      monthValue - 1,
      dayValue,
      hourValue,
      minuteValue,
      secondValue,
    ),
  );
  if (
    candidate.getUTCFullYear() !== yearValue ||
    candidate.getUTCMonth() !== monthValue - 1 ||
    candidate.getUTCDate() !== dayValue ||
    candidate.getUTCHours() !== hourValue ||
    candidate.getUTCMinutes() !== minuteValue ||
    candidate.getUTCSeconds() !== secondValue
  ) {
    return undefined;
  }
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function localDatetimeAt(epochMs: number, utcOffsetMinutes: number): string {
  return new Date(epochMs + utcOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 19);
}

function lineWithoutCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function propertyValue(line: string, propertyName: string): string | undefined {
  const normalized = lineWithoutCarriageReturn(line);
  const prefix = `${propertyName}:`;
  if (!normalized.startsWith(prefix)) return undefined;
  const value = normalized.slice(prefix.length).trim();
  return value || undefined;
}

function propertyOccurrences(
  lines: readonly string[],
  closingDelimiter: number,
  propertyName: string,
): number {
  const prefix = `${propertyName}:`;
  let count = 0;
  for (let index = 1; index < closingDelimiter; index += 1) {
    if (lineWithoutCarriageReturn(lines[index] ?? "").startsWith(prefix)) {
      count += 1;
    }
  }
  return count;
}

export function resolveModifiedTimeSettlement(
  expectedContent: string,
  observedContent: string,
  policy: ModifiedTimeSettlementPolicy | undefined,
  window: ModifiedTimeSettlementWindow,
): ModifiedTimeSettlementEvidence | undefined {
  if (!policy || policy.integrations.length === 0) return undefined;
  const duration =
    window.settlementObservedAtEpochMs - window.applyStartedAtEpochMs;
  if (
    !Number.isFinite(window.applyStartedAtEpochMs) ||
    !Number.isFinite(window.settlementObservedAtEpochMs) ||
    !Number.isInteger(policy.utcOffsetMinutes) ||
    policy.utcOffsetMinutes < -14 * 60 ||
    policy.utcOffsetMinutes > 14 * 60 ||
    duration < 0 ||
    duration > MAX_SETTLEMENT_WINDOW_MS
  ) {
    return undefined;
  }

  const expectedLines = expectedContent.split("\n");
  const observedLines = observedContent.split("\n");
  if (expectedLines.length !== observedLines.length) return undefined;
  if (
    lineWithoutCarriageReturn(expectedLines[0] ?? "") !== "---" ||
    lineWithoutCarriageReturn(observedLines[0] ?? "") !== "---"
  ) {
    return undefined;
  }
  const closingDelimiter = expectedLines.findIndex(
    (line, index) => index > 0 && lineWithoutCarriageReturn(line) === "---",
  );
  if (
    closingDelimiter < 0 ||
    lineWithoutCarriageReturn(observedLines[closingDelimiter] ?? "") !== "---"
  ) {
    return undefined;
  }
  const drift = expectedLines
    .map((line, index) => (line === observedLines[index] ? -1 : index))
    .filter((index) => index >= 0);
  if (
    drift.length !== 1 ||
    drift[0] === undefined ||
    drift[0] <= 0 ||
    drift[0] >= closingDelimiter
  ) {
    return undefined;
  }

  const driftLine = drift[0];
  const applyStarted = localDatetimeAt(
    window.applyStartedAtEpochMs,
    policy.utcOffsetMinutes,
  );
  const settlementObserved = localDatetimeAt(
    window.settlementObservedAtEpochMs,
    policy.utcOffsetMinutes,
  );
  for (const integration of policy.integrations) {
    if (
      propertyOccurrences(
        expectedLines,
        closingDelimiter,
        integration.propertyName,
      ) !== 1 ||
      propertyOccurrences(
        observedLines,
        closingDelimiter,
        integration.propertyName,
      ) !== 1
    ) {
      continue;
    }
    const expectedRaw = propertyValue(
      expectedLines[driftLine] ?? "",
      integration.propertyName,
    );
    const observedRaw = propertyValue(
      observedLines[driftLine] ?? "",
      integration.propertyName,
    );
    if (!expectedRaw || !observedRaw) continue;
    const expectedCanonical = validLocalDatetime(expectedRaw);
    const observedCanonical = validLocalDatetime(observedRaw);
    const observedHasSeconds = STRICT_LOCAL_DATETIME.exec(observedRaw)?.[6];
    if (
      !expectedCanonical ||
      !observedCanonical ||
      observedCanonical.localeCompare(expectedCanonical) <= 0 ||
      (observedHasSeconds
        ? observedCanonical.localeCompare(applyStarted) < 0 ||
          observedCanonical.localeCompare(settlementObserved) > 0
        : observedCanonical
            .slice(0, 16)
            .localeCompare(applyStarted.slice(0, 16)) < 0 ||
          observedCanonical
            .slice(0, 16)
            .localeCompare(settlementObserved.slice(0, 16)) > 0)
    ) {
      continue;
    }
    const restored = [...observedLines];
    restored[driftLine] = expectedLines[driftLine] ?? "";
    if (restored.join("\n") !== expectedContent) continue;
    return {
      contractVersion: 1,
      kind: "modified-time-frontmatter",
      pluginId: integration.pluginId,
      propertyName: integration.propertyName,
      observedSha256: createHash("sha256")
        .update(observedContent, "utf8")
        .digest("hex"),
      observedAt: new Date(window.settlementObservedAtEpochMs).toISOString(),
    };
  }
  return undefined;
}
