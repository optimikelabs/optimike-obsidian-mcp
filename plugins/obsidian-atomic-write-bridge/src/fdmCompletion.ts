import { randomUUID } from 'node:crypto';
import { getFrontmatterDateIntegrationContract } from './modifiedTimeIntegrations.js';
import { sha256 } from './contract.js';

type Observation = { state: string; epoch: string; generation?: number; sha256?: string };
type Signal = { contractVersion: number; implementation: string; epoch: string;
  begin(path: string): string | null; activate(key: string): void; cancel(key: string): void; observe(key: string): Promise<Observation> };
type Entry = { path: string; api: Signal; key: string; started: number; policy: string };
export function createFdmCompletion(app: any) {
  const receipts = new Map<string, Entry>();
  function policy() { return JSON.stringify(getFrontmatterDateIntegrationContract(app)); }
  function signal(): Signal | undefined {
    const fdm = app.plugins?.getPlugin?.('frontmatter-date-manager');
    const api = fdm?.optimikeSettlement;
    const dates = getFrontmatterDateIntegrationContract(app).settlementIntegrations;
    if (fdm?.manifest?.version !== '1.6.0' || dates.length !== 1 || dates[0]?.pluginId !== 'frontmatter-date-manager'
      || api?.contractVersion !== 1 || !['elysia-fdm-1.6.0-v1', 'elysia-fdm-1.6.0-v2'].includes(api.implementation)) return;
    return api;
  }
  function prune() {
    for (const [token, entry] of receipts) if (Date.now() - entry.started > 300000) {
      entry.api.cancel(entry.key); receipts.delete(token);
    }
    while (receipts.size > 512) { const token = receipts.keys().next().value!;
      const entry = receipts.get(token)!; entry.api.cancel(entry.key); receipts.delete(token); }
  }
  return {
    capability: () => ({ contractVersion: 1, available: !!signal(), implementation: 'fdm-completion-v1' }),
    begin(path: string): string | undefined {
      prune(); const api = signal(); if (!api) return;
      const key = api.begin(path); if (!key) return;
      const token = randomUUID(); receipts.set(token, { path, api, key, started: Date.now(), policy: policy() }); prune(); return token;
    },
    cancel(token: string | undefined) { if (!token) return; const entry = receipts.get(token);
      if (entry) entry.api.cancel(entry.key); receipts.delete(token); },
    activate(token: string | undefined) { const entry = token ? receipts.get(token) : undefined; if (entry) entry.api.activate(entry.key); },
    async read(path: string, token: string, read: () => Promise<string>) {
      prune(); const entry = receipts.get(token);
      const valid = () => entry && entry.path === path && entry.api === signal() && entry.policy === policy();
      if (!valid()) return { content: await read() };
      const before = await entry!.api.observe(entry!.key);
      const content = await read();
      const after = await entry!.api.observe(entry!.key);
      if (valid() && before.state === 'complete' && after.state === 'complete'
        && before.epoch === after.epoch && before.generation === after.generation
        && before.sha256 === after.sha256 && after.sha256 === sha256(content))
        return {content, completion: { contractVersion: 1, kind: 'fdm-completion-v1', token,
          epoch: after.epoch, generation: after.generation, state: 'complete' }};
      if (valid()) return {content, completion: {contractVersion: 1, kind: 'fdm-completion-v1', token,
        epoch: entry!.api.epoch, generation: after.generation ?? 0, state: 'pending'}};
      return { content };
    },
    dispose() { for (const entry of receipts.values()) entry.api.cancel(entry.key); receipts.clear(); },
  };
}
