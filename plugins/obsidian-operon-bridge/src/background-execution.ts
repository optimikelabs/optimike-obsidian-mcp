/** Keep the owning Desktop renderer responsive while serving REST requests.
 * No polling or task/index mutation. Restore the previous window policy when
 * the REST mount is removed. Mobile never loads Electron.
 */
interface WebContents {
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(value: boolean): void;
  isDestroyed?(): boolean;
}
export function acquireBackgroundExecution(
  desktop: boolean,
  load: (name: string) => unknown,
): (() => void) | null {
  if (!desktop) return () => {};
  let contents: WebContents | undefined;
  let previous: boolean | undefined;
  try {
    const electron = load("electron") as { remote?: unknown };
    const remote = (electron.remote ?? load("@electron/remote")) as {
      getCurrentWebContents(): WebContents;
    };
    contents = remote.getCurrentWebContents();
    if (contents.isDestroyed?.()) return null;
    previous = contents.getBackgroundThrottling();
    if (typeof previous !== "boolean") return null;
    if (previous) contents.setBackgroundThrottling(false);
    if (contents.getBackgroundThrottling() !== false) throw new Error("Policy not applied");
  } catch {
    if (contents && previous === true) {
      try { if (!contents.isDestroyed?.()) contents.setBackgroundThrottling(previous); } catch { /* Window may be closing. */ }
    }
    return null;
  }
  const target = contents;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!previous) return;
    try { if (!target.isDestroyed?.()) target.setBackgroundThrottling(previous); } catch { /* Window may be closing. */ }
  };
}
