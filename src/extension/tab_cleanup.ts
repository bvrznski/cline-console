import path from "node:path";

export interface CleanupTab {
  uris: readonly string[];
  dirty: boolean;
  pinned?: boolean;
  close(): PromiseLike<boolean>;
}

export interface TabCleanupResult { closed: number; preservedDirty: number; preservedPinned: number; }

export async function cleanupTaskTabs(tabs: readonly CleanupTab[], trackedUris: Set<string>, workspace: string, closeUntracked = false): Promise<TabCleanupResult> {
  const workspaceRoot = path.resolve(workspace);
  let closed = 0;
  let preservedDirty = 0;
  let preservedPinned = 0;
  for (const tab of tabs) {
    const workspaceUris = tab.uris.filter(uri => {
      const relative = path.relative(workspaceRoot, path.resolve(uri));
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (!workspaceUris.length || (!closeUntracked && !workspaceUris.some(uri => trackedUris.has(uri)))) continue;
    if (tab.dirty) {
      preservedDirty++;
      continue;
    }
    if (tab.pinned) {
      preservedPinned++;
      continue;
    }
    try {
      if (await tab.close()) {
        for (const uri of workspaceUris) trackedUris.delete(uri);
        closed++;
      }
    } catch { /* A tab may close while cleanup is in progress. */ }
  }
  return { closed, preservedDirty, preservedPinned };
}
