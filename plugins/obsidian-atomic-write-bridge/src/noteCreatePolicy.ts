import { getFrontmatterDateIntegrationContract } from "./modifiedTimeIntegrations.js";
import { validateCreatePolicy, type NoteCreatePolicy, type CreateDateField } from "../../../src/services/noteCreateContract.js";

/** Admit only the formats/delays already qualified by the existing Bridge integration contract. */
export function noteCreateDatePolicy(app: unknown, utcOffsetMinutes = -new Date().getTimezoneOffset()): NoteCreatePolicy {
  const contract = getFrontmatterDateIntegrationContract(app);
  if (contract.unsupportedIntegrations.length) throw new Error("create_date_configuration_unsupported");
  const fields: CreateDateField[] = [];
  for (const protection of contract.protectionIntegrations) {
    if (protection.viewedPropertyName) throw new Error("create_viewed_fields_unsupported");
    const qualified = contract.settlementIntegrations.filter(item => item.pluginId === protection.pluginId);
    if (qualified.length !== 1 || qualified[0].propertyName !== protection.modifiedPropertyName) {
      throw new Error("create_date_configuration_unsupported");
    }
    for (const role of ["created", "modified"] as const) {
      const propertyName = role === "created" ? protection.createdPropertyName : protection.modifiedPropertyName;
      if (propertyName) fields.push({ pluginId: protection.pluginId, propertyName, role,
        delayMs: qualified[0].settlementObservationDelayMs });
    }
  }
  return validateCreatePolicy({ version: 1, utcOffsetMinutes, fields });
}
