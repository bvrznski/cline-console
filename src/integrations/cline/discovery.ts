import * as vscode from "vscode";

export const CLINE_EXTENSION_IDS = ["saoudrizwan.claude-dev", "saoudrizwan.claude-dev-nightly"] as const;

export function discoverCline(): vscode.Extension<unknown> | undefined {
  for (const id of CLINE_EXTENSION_IDS) {
    const extension = vscode.extensions.getExtension(id);
    if (extension) return extension;
  }
  return undefined;
}
