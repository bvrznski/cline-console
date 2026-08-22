import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { DEFAULT_TASK_SCANNER_OPTIONS } from "../src/extension/task_queue";

test("global task scanner manifest settings match runtime defaults", async () => {
  const manifest = JSON.parse(await fs.readFile("package.json", "utf8")) as {
    contributes: { configuration: { properties: Record<string, { default: unknown; scope?: string }> } };
  };
  const settings = manifest.contributes.configuration.properties;
  const expected: Record<string, unknown> = {
    "cline-console.taskScanner.enabled": DEFAULT_TASK_SCANNER_OPTIONS.enabled,
    "cline-console.taskScanner.terminalStabilitySeconds": DEFAULT_TASK_SCANNER_OPTIONS.terminalStabilityMs / 1_000,
    "cline-console.taskScanner.interTaskDelaySeconds": DEFAULT_TASK_SCANNER_OPTIONS.interTaskDelayMs / 1_000,
    "cline-console.taskScanner.detectIncompleteCompletions": DEFAULT_TASK_SCANNER_OPTIONS.detectIncompleteCompletions,
    "cline-console.taskScanner.detectTestTimeouts": DEFAULT_TASK_SCANNER_OPTIONS.detectTestTimeouts,
    "cline-console.taskScanner.implementAuditRecommendations": DEFAULT_TASK_SCANNER_OPTIONS.implementAuditRecommendations,
    "cline-console.taskScanner.requirePostImplementationReport": DEFAULT_TASK_SCANNER_OPTIONS.requirePostImplementationReport
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(settings[key]?.default, value, `${key} default drifted from runtime`);
    assert.equal(settings[key]?.scope, "application", `${key} must remain global`);
  }
});
