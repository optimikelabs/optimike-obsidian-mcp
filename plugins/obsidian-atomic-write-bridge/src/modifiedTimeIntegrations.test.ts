import assert from "node:assert/strict";
import test from "node:test";
import { getModifiedTimeIntegrations } from "./modifiedTimeIntegrations.js";

function app(plugins: Record<string, unknown>) {
  return { plugins: { plugins } };
}

test("resolves supported enabled modified-time plugin settings", () => {
  assert.deepEqual(
    getModifiedTimeIntegrations(
      app({
        "update-time-on-edit": {
          settings: {
            dateFormat: "yyyy-MM-dd'T'HH:mm",
            enableNumberProperties: false,
            headerUpdated: "legacyModified",
          },
        },
        "frontmatter-date-manager": {
          settings: {
            dateFormat: "yyyy-MM-dd'T'HH:mm:ss",
            enableAutoUpdate: true,
            enableModifiedTime: true,
            enableNumberProperties: false,
            headerUpdated: "modification",
            timezone: "",
          },
        },
        "update-time": { settings: { updatedPropertyName: "updated" } },
      }),
    ),
    [
      { pluginId: "update-time-on-edit", propertyName: "legacyModified" },
      {
        pluginId: "frontmatter-date-manager",
        propertyName: "modification",
      },
      { pluginId: "update-time", propertyName: "updated" },
    ],
  );
});

test("rejects inactive, numeric, timezone and unsafe configurations", () => {
  assert.deepEqual(
    getModifiedTimeIntegrations(
      app({
        "update-time-on-edit": {
          settings: {
            dateFormat: "yyyy/MM/dd HH:mm",
            headerUpdated: "legacyModified",
          },
        },
        "frontmatter-date-manager": {
          settings: {
            dateFormat: "yyyy-MM-dd'T'HH:mm:ss",
            enableAutoUpdate: false,
            enableModifiedTime: true,
            headerUpdated: "modification",
          },
        },
        "update-time": { settings: { updatedPropertyName: "bad:key" } },
      }),
    ),
    [],
  );
  assert.deepEqual(
    getModifiedTimeIntegrations(
      app({
        "update-time": { settings: { updatedPropertyName: "true" } },
      }),
    ),
    [],
  );
  assert.deepEqual(
    getModifiedTimeIntegrations(
      app({
        "update-time": { settings: { updatedPropertyName: "modified,time" } },
      }),
    ),
    [],
  );
  assert.deepEqual(
    getModifiedTimeIntegrations(
      app({
        "update-time": { settings: { updatedPropertyName: "#modified" } },
      }),
    ),
    [],
  );
});

test("accepts source-stable plain YAML property names", () => {
  assert.deepEqual(
    getModifiedTimeIntegrations(
      app({
        "update-time-on-edit": {
          settings: {
            dateFormat: "yyyy-MM-dd'T'HH:mm",
            headerUpdated: "last modified",
          },
        },
        "update-time": { settings: { updatedPropertyName: "modified.at" } },
      }),
    ),
    [
      { pluginId: "update-time-on-edit", propertyName: "last modified" },
      { pluginId: "update-time", propertyName: "modified.at" },
    ],
  );
});

test("deduplicates properties exposed by more than one supported plugin", () => {
  assert.deepEqual(
    getModifiedTimeIntegrations(
      app({
        "update-time-on-edit": {
          settings: {
            dateFormat: "yyyy-MM-dd'T'HH:mm",
            headerUpdated: "modification",
          },
        },
        "frontmatter-date-manager": {
          settings: {
            dateFormat: "yyyy-MM-dd'T'HH:mm:ss",
            enableAutoUpdate: true,
            headerUpdated: "modification",
          },
        },
      }),
    ),
    [{ pluginId: "update-time-on-edit", propertyName: "modification" }],
  );
});
