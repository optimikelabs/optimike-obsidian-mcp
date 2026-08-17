const LOCAL_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;
const PLUGIN_FRESHNESS_MARGIN_MS = 5_200;

export function isSafeModifiedTimePropertyName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[,\r\n:]/u.test(value)
  );
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
  return (
    currentEpochMs + Math.max(representableTickMs, PLUGIN_FRESHNESS_MARGIN_MS)
  );
}
