// Local, version-fenced extension for the audited FDM 1.6.0 build.
// It observes the existing pipeline and shortens only its initial modify debounce
// for a live governed checkpoint. Native retry/new-file delays and dates stay owned by FDM.
export function installFdmSettlementSignal(plugin) {
  const entries = new Map();
  const epoch = globalThis.crypto.randomUUID();
  let alive = true;
  const methods = [];
  const ttl = 300000;
  async function digest(content) {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function prune() {
    for (const [key, row] of entries) if (Date.now() - row.started > ttl) entries.delete(key);
    while (entries.size > 512) entries.delete(entries.keys().next().value);
  }
  const rows = path => [...entries.values()].filter(row => row.path === path);
  function changed(file) {
    for (const row of rows(file.path)) { row.generation++; row.completed = -1; }
  }
  function invalidate(file, oldPath) {
    for (const [key, row] of entries) if (row.path === file.path || row.path === oldPath) entries.delete(key);
  }
  plugin.registerEvent(plugin.app.vault.on('modify', changed));
  plugin.registerEvent(plugin.app.vault.on('rename', invalidate));
  plugin.registerEvent(plugin.app.vault.on('delete', invalidate));
  for (const name of ['processFileWithLock', 'handleFileChange', 'handleFileOpen']) {
    const original = plugin[name];
    if (typeof original !== 'function') throw new Error('Unsupported FDM pipeline');
    const wrapped = async function(file, ...args) {
      const selected = rows(file.path);
      for (const row of selected) { row.inFlight++; if (name === 'handleFileOpen') row.completed = -1; }
      const generations = selected.map(row => row.generation);
      const barriers = selected.map(row => row.barrier);
      let result;
      try { result = await original.call(this, file, ...args); return result; }
      finally {
        let observedHash;
        if (name === 'processFileWithLock' && selected.some((row, index) => row.active
          && row.barrier === barriers[index] && row.generation === generations[index])
          && result?.status === 'ok' && result.deferred !== true && !result.blocked) {
          try { observedHash = await digest(await plugin.app.vault.read(file)); } catch { /* no acknowledgement */ }
        }
        selected.forEach((row, index) => {
          row.inFlight--;
          // Only the locked modify pipeline can acknowledge a complete pass.
          if (name === 'processFileWithLock' && row.active && row.barrier === barriers[index] && row.generation === generations[index]) {
            row.completed = observedHash ? row.generation : -1;
            row.sha256 = observedHash;
          }
        });
      }
    };
    plugin[name] = wrapped;
    methods.push([name, original, wrapped]);
  }
  const api = {
    contractVersion: 1, implementation: 'elysia-fdm-1.6.0-v2', epoch,
    modifyDebounceMs(file) {
      prune();
      // The checkpoint is admitted by the Bridge before CAS. Only the original
      // modify handler calls this: scheduleRetry and new-file windows never do.
      // Concurrent changes still advance generation and invalidate the proof.
      const eligible = alive && rows(file.path).some(row => row.accelerate
        && row.settings === JSON.stringify(plugin.settings));
      return eligible ? 100 : 2000;
    },
    begin(path) {
      prune();
      if (!alive) return null;
      const key = globalThis.crypto.randomUUID();
      entries.set(key, {path, generation: 0, completed: -1, inFlight: 0, active: false, accelerate: true, barrier: 0, started: Date.now(), settings: JSON.stringify(plugin.settings)});
      prune();
      return key;
    },
    activate(key) { const row = entries.get(key); if (row) { row.active = true; row.barrier++; row.completed = -1; } },
    cancel(key) { entries.delete(key); },
    async observe(key) {
      prune();
      const row = entries.get(key);
      const pending = () => !alive || !row || row.settings !== JSON.stringify(plugin.settings)
        || !plugin.automaticDatesAllowed() || plugin.bulkRunning || plugin.renameSuppression
        || !row.active || row.generation === 0 || row.completed !== row.generation || row.inFlight !== 0
        || plugin.modifyTimers.has(row.path) || plugin.newFileTimers.has(row.path)
        || plugin.recentlyCreated.has(row.path) || plugin.newFileModified.has(row.path)
        || plugin.manualPending.has(row.path) || plugin.processingFiles.has(row.path);
      if (pending()) return { state: 'pending', epoch };
      const generation = row.generation;
      const file = plugin.app.vault.getAbstractFileByPath(row.path);
      if (!file || await plugin.getWriteBlock(file) !== null || pending() || row.generation !== generation)
        return { state: 'pending', epoch };
      row.accelerate = false;
      return { state: 'complete', epoch, generation, sha256: row.sha256 };
    },
  };
  plugin.optimikeSettlement = api;
  plugin.register(() => {
    alive = false; entries.clear();
    for (const [name, original, wrapped] of methods) if (plugin[name] === wrapped) plugin[name] = original;
    if (plugin.optimikeSettlement === api) delete plugin.optimikeSettlement;
  });
  return api;
}
