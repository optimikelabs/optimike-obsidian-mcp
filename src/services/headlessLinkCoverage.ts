import { BaseErrorCode, McpError } from "../types-global/errors.js";

export const HEADLESS_LINK_COVERAGE_INCOMPLETE = "headless_link_coverage_incomplete";
export const LIMITED_LINK_SOURCE_LIMIT = 20;
export type LinkSourceLimitReason = "cap" | "region" | "timeout" | "oom";
export type LimitedLinkSource = { path: string; reason: LinkSourceLimitReason };
export type LimitedLinkSources = { limitedSourceCount: number; limitedSources: LimitedLinkSource[] };

export function isLinkSourceLimitReason(value: unknown): value is LinkSourceLimitReason {
  return value === "cap" || value === "region" || value === "timeout" || value === "oom";
}

/** Existing vault names may be nonportable. Accept only decoded, relative Markdown paths. */
export function isLimitedLinkSourcePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 &&
    !/^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(value) &&
    !/[\\\u0000-\u001f\u007f-\u009f]/u.test(value) && /\.md$/iu.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function incompleteHeadlessLinkCoverageError({ limitedSourceCount, limitedSources }: LimitedLinkSources): McpError {
  return new McpError(BaseErrorCode.VALIDATION_ERROR, "The operation requires complete link coverage.", {
    reasonCode: HEADLESS_LINK_COVERAGE_INCOMPLETE, limitedSourceCount, limitedSources,
  });
}
