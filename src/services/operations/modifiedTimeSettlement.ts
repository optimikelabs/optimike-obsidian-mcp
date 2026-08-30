import { createHash } from "node:crypto";

export type ModifiedTimeIntegration = {
  pluginId: "update-time-on-edit" | "frontmatter-date-manager" | "update-time";
  propertyName: string;
  settlementObservationDelayMs: number;
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

function frontmatterClosingDelimiter(lines: readonly string[]): number {
  return lines.findIndex(
    (line, index) => index > 0 && lineWithoutCarriageReturn(line) === "---",
  );
}

function timestampIsWithinSettlementWindow(
  raw: string,
  applyStarted: string,
  settlementObserved: string,
): string | undefined {
  const canonical = validLocalDatetime(raw);
  if (!canonical) return undefined;
  const hasSeconds = STRICT_LOCAL_DATETIME.exec(raw)?.[6];
  if (
    hasSeconds
      ? canonical.localeCompare(applyStarted) < 0 ||
        canonical.localeCompare(settlementObserved) > 0
      : canonical.slice(0, 16).localeCompare(applyStarted.slice(0, 16)) < 0 ||
        canonical.slice(0, 16).localeCompare(settlementObserved.slice(0, 16)) >
          0
  ) {
    return undefined;
  }
  return canonical;
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
  if (
    lineWithoutCarriageReturn(expectedLines[0] ?? "") !== "---" ||
    lineWithoutCarriageReturn(observedLines[0] ?? "") !== "---"
  ) {
    return undefined;
  }
  const expectedClosingDelimiter = frontmatterClosingDelimiter(expectedLines);
  const observedClosingDelimiter = frontmatterClosingDelimiter(observedLines);
  if (expectedClosingDelimiter < 0 || observedClosingDelimiter < 0) {
    return undefined;
  }
  const applyStarted = localDatetimeAt(
    window.applyStartedAtEpochMs,
    policy.utcOffsetMinutes,
  );
  const settlementObserved = localDatetimeAt(
    window.settlementObservedAtEpochMs,
    policy.utcOffsetMinutes,
  );
  for (const integration of policy.integrations) {
    const expectedOccurrences = propertyOccurrences(
      expectedLines,
      expectedClosingDelimiter,
      integration.propertyName,
    );
    const observedOccurrences = propertyOccurrences(
      observedLines,
      observedClosingDelimiter,
      integration.propertyName,
    );
    let observedRaw: string | undefined;

    if (
      expectedOccurrences === 1 &&
      observedOccurrences === 1 &&
      expectedLines.length === observedLines.length &&
      expectedClosingDelimiter === observedClosingDelimiter
    ) {
      const drift = expectedLines
        .map((line, index) => (line === observedLines[index] ? -1 : index))
        .filter((index) => index >= 0);
      const driftLine = drift[0];
      if (
        drift.length !== 1 ||
        driftLine === undefined ||
        driftLine <= 0 ||
        driftLine >= expectedClosingDelimiter
      ) {
        continue;
      }
      const expectedRaw = propertyValue(
        expectedLines[driftLine] ?? "",
        integration.propertyName,
      );
      observedRaw = propertyValue(
        observedLines[driftLine] ?? "",
        integration.propertyName,
      );
      const expectedCanonical = expectedRaw
        ? validLocalDatetime(expectedRaw)
        : undefined;
      const observedCanonical = observedRaw
        ? timestampIsWithinSettlementWindow(
            observedRaw,
            applyStarted,
            settlementObserved,
          )
        : undefined;
      if (
        !expectedCanonical ||
        !observedCanonical ||
        observedCanonical.localeCompare(expectedCanonical) <= 0
      ) {
        continue;
      }
      const restored = [...observedLines];
      restored[driftLine] = expectedLines[driftLine] ?? "";
      if (restored.join("\n") !== expectedContent) continue;
    } else if (
      expectedOccurrences === 0 &&
      observedOccurrences === 1 &&
      observedLines.length === expectedLines.length + 1 &&
      observedClosingDelimiter === expectedClosingDelimiter + 1
    ) {
      const insertedLine = observedLines.findIndex(
        (line, index) =>
          index > 0 &&
          index < observedClosingDelimiter &&
          propertyValue(line, integration.propertyName) !== undefined,
      );
      if (insertedLine < 0) continue;
      observedRaw = propertyValue(
        observedLines[insertedLine] ?? "",
        integration.propertyName,
      );
      if (
        !observedRaw ||
        !timestampIsWithinSettlementWindow(
          observedRaw,
          applyStarted,
          settlementObserved,
        )
      ) {
        continue;
      }
      const restored = [...observedLines];
      restored.splice(insertedLine, 1);
      if (restored.join("\n") !== expectedContent) continue;
    } else {
      continue;
    }

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
