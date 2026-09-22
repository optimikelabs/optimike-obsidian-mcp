import assert from 'node:assert/strict';

/** Configuration saying "live" is not a functional Desktop observation. */
export function requireObservedDesktop(status) {
  assert.equal(status.runtimeMode, 'live', 'Desktop live gate not exercised');
  const manifest = status.capabilityManifest;
  assert.equal(manifest?.registrationMode, 'live');
  for (const id of ['local-rest', 'vault-read']) {
    const capability = manifest.capabilities?.find(entry => entry.id === id);
    assert.equal(capability?.available, true, 'Desktop dependency unavailable');
    assert.equal(capability?.authorized, true, 'Desktop dependency unauthorized');
    assert.equal(capability?.state, 'ready', 'Desktop dependency not ready');
    assert.equal(capability?.reasonCode, 'ready', 'cache or configured state is not live proof');
  }
}
