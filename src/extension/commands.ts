import * as vscode from "vscode";
import type { ClineAdapter } from "../integrations/cline/types";
import type { IpcServer } from "./server";

export function registerCommands(context: vscode.ExtensionContext, server: IpcServer, adapter: ClineAdapter, start: () => Promise<void>, stop: () => Promise<void>): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("cline-console.startServer", start),
    vscode.commands.registerCommand("cline-console.stopServer", stop),
    vscode.commands.registerCommand("cline-console.showStatus", async () => vscode.window.showInformationMessage(JSON.stringify(await adapter.getStatus()))),
    vscode.commands.registerCommand("cline-console.testClineIntegration", async () => {
      const capabilities = await adapter.getCapabilities();
      vscode.window.showInformationMessage(`Cline Console capabilities: ${JSON.stringify(capabilities)}`);
    }),
    vscode.commands.registerCommand("cline-console.copySocketPath", async () => {
      if (!server.socketPath) return vscode.window.showWarningMessage("Cline Console server is not running.");
      await vscode.env.clipboard.writeText(server.socketPath);
      return vscode.window.showInformationMessage("Cline Console socket path copied.");
    })
  );
}
