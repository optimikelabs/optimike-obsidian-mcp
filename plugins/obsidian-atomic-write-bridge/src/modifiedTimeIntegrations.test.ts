import assert from "node:assert/strict";
import test from "node:test";
import {
  getFrontmatterDateIntegrations,
  getModifiedTimeIntegrations,
} from "./modifiedTimeIntegrations.js";

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
      {
        pluginId: "update-time-on-edit",
        propertyName: "legacyModified",
        settlementObservationDelayMs: 250,
      },
      {
        pluginId: "frontmatter-date-manager",
        propertyName: "modification",
        settlementObservationDelayMs: 37_250,
      },
      {
        pluginId: "update-time",
        propertyName: "updated",
        settlementObservationDelayMs: 2_250,
      },
    ],
  );
});

test("reports the configured creation and modification properties independently", () => {
  assert.deepEqual(
    getFrontmatterDateIntegrations(
      app({
        "update-time-on-edit": {
          settings: {
            enableCreateTime: true,
            headerCreated: "bornAt",
            headerUpdated: "changedAt",
          },
        },
        "frontmatter-date-manager": {
          settings: {
            enableAutoUpdate: true,
            enableCreateTime: false,
            enableModifiedTime: true,
            enableLastViewed: true,
            headerCreated: "creationDisabled",
            headerUpdated: "last touched",
            headerLastViewed: "last viewed at",
          },
        },
        "update-time": {
          settings: {
            createdPropertyName: "  created.by.plugin  ",
            updatedPropertyName: "   ",
          },
        },
      }),
    ),
    [
      {
        pluginId: "update-time-on-edit",
        createdPropertyName: "bornAt",
        modifiedPropertyName: "changedAt",
      },
      {
        pluginId: "frontmatter-date-manager",
        modifiedPropertyName: "last touched",
        viewedPropertyName: "last viewed at",
      },
      {
        pluginId: "update-time",
        createdPropertyName: "created.by.plugin",
        modifiedPropertyName: "updated",
      },
    ],
  );
});

test("does not advertise inactive or unsafe date properties for protection", () => {
  assert.deepEqual(
    getFrontmatterDateIntegrations(
      app({
        "frontmatter-date-manager": {
          settings: {
            enableAutoUpdate: false,
            enableCreateTime: true,
            enableModifiedTime: true,
            headerCreated: "created",
            headerUpdated: "updated",
          },
        },
        "update-time-on-edit": {
          settings: {
            enableCreateTime: true,
            headerCreated: "bad:key",
            headerUpdated: "modified,time",
          },
        },
      }),
    ),
    [],
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
      {
        pluginId: "update-time-on-edit",
        propertyName: "last modified",
        settlementObservationDelayMs: 250,
      },
      {
        pluginId: "update-time",
        propertyName: "modified.at",
        settlementObservationDelayMs: 2_250,
      },
    ],
  );
  assert.deepEqual(
    getModifiedTimeIntegrations(
      app({
        "update-time": {
          settings: { updatedPropertyName: "   " },
        },
      }),
    ),
    [
      {
        pluginId: "update-time",
        propertyName: "updated",
        settlementObservationDelayMs: 2_250,
      },
    ],
  );
});

test("keeps each active plugin when they share one property", () => {
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
    [
      {
        pluginId: "update-time-on-edit",
        propertyName: "modification",
        settlementObservationDelayMs: 250,
      },
      {
        pluginId: "frontmatter-date-manager",
        propertyName: "modification",
        settlementObservationDelayMs: 37_250,
      },
    ],
  );
});

test("keeps protection but withholds settlement for excessive deferred writes", () => {
  const configuredApp = app({
    "frontmatter-date-manager": {
      settings: {
        dateFormat: "yyyy-MM-dd'T'HH:mm:ss",
        enableAutoUpdate: true,
        enableModifiedTime: true,
        enableNumberProperties: false,
        headerUpdated: "changedAt",
        minSecondsBetweenSaves: 300,
        timezone: "",
      },
    },
  });
  assert.deepEqual(getModifiedTimeIntegrations(configuredApp), []);
  assert.deepEqual(getFrontmatterDateIntegrations(configuredApp), [
    {
      pluginId: "frontmatter-date-manager",
      modifiedPropertyName: "changedAt",
    },
  ]);
});

test("withholds FDM settlement when another managed effect is enabled", () => {
  for (const unsafeSettings of [
    { countUpdatesEnabled: true },
    { postUpdateCommand: "workspace:save-file" },
    { inversionFixStrategy: "clamp-created" },
  ]) {
    const configuredApp = app({
      "frontmatter-date-manager": {
        settings: {
          dateFormat: "yyyy-MM-dd'T'HH:mm:ss",
          enableAutoUpdate: true,
          enableModifiedTime: true,
          enableNumberProperties: false,
          headerUpdated: "changedAt",
          timezone: "",
          ...unsafeSettings,
        },
      },
    });
    assert.deepEqual(getModifiedTimeIntegrations(configuredApp), []);
    assert.deepEqual(getFrontmatterDateIntegrations(configuredApp), [
      {
        pluginId: "frontmatter-date-manager",
        modifiedPropertyName: "changedAt",
      },
    ]);
  }
});
