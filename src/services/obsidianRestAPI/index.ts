/**
 * @module ObsidianRestApiService Barrel File
 * @description
 * Exports the singleton instance of the Obsidian REST API service and related types.
 */

export * from "./types.js"; // Export all types
// Removed singleton export
export { ObsidianRestApiService } from "./service.js"; // Export the class itself
// Export method modules if direct access is desired, though typically accessed via service instance
export * as activeFileMethods from "./methods/activeFileMethods.js";
export * as atomicWriteMethods from "./methods/atomicWriteMethods.js";
export * as basesMethods from "./methods/basesMethods.js";
export * as commandMethods from "./methods/commandMethods.js";
export * as openMethods from "./methods/openMethods.js";
export * as patchMethods from "./methods/patchMethods.js";
export * as searchMethods from "./methods/searchMethods.js";
export * as vaultMethods from "./methods/vaultMethods.js";
export { VaultCacheService } from "./vaultCache/index.js";
