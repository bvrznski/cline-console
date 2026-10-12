import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registrationPath } from "../src/extension/workspace_registry";

// Import the module synchronously to work with CommonJS
const hangupDetectorModule = require("../src/extension/hangup_detector") as {
  pingExtension: typeof import("../src/extension/hangup_detector").pingExtension;
  detectExtensionHangup: typeof import("../src/extension/hangup_detector").detectExtensionHangup;
  restartExtension: typeof import("../src/extension/hangup_detector").restartExtension;
  waitForReplacementRegistration: typeof import("../src/extension/hangup_detector").waitForReplacementRegistration;
};
const { pingExtension, detectExtensionHangup, restartExtension, waitForReplacementRegistration } = hangupDetectorModule;

test("pingExtension returns false for non-existent socket", async () => {
  const registration = {
    protocolVersion: 1 as const,
    id: "test",
    workspace: "/tmp/test-workspace",
    socketPath: "/tmp/nonexistent.sock",
    pid: process.pid,
    registeredAt: new Date().toISOString()
  };

  // Should return false since the socket doesn't exist
  const result = await pingExtension(registration, 100);
  assert.equal(result, false);
});

test("detectExtensionHangup returns hung=true when extension does not respond to pings", async () => {
  const registration = {
    protocolVersion: 1 as const,
    id: "test",
    workspace: "/tmp/test-workspace",
    socketPath: "/tmp/nonexistent.sock",
    pid: process.pid,
    registeredAt: new Date().toISOString()
  };

  // When the socket doesn't exist, extension will fail to respond to pings
  // After maxConsecutiveFailures (2 in test), it should return hung=true
  const result = await detectExtensionHangup(registration, { pingTimeoutMs: 100, maxConsecutiveFailures: 2 });
  assert.equal(result.hung, true);
});

test("restartExtension throws error if extension is not running", async () => {
  const registration = {
    protocolVersion: 1 as const,
    id: "test",
    workspace: "/tmp/test-workspace",
    socketPath: "/tmp/nonexistent.sock",
    pid: 999999, // Non-existent PID
    registeredAt: new Date().toISOString()
  };

  await assert.rejects(() => restartExtension(registration));
});

test("restart verification accepts only a live replacement PID for the exact workspace", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-replacement-"));
  const registration = {
    protocolVersion: 1 as const, id: "workspace-id", workspace: "/repo",
    socketPath: "/tmp/old.sock", pid: 999999, registeredAt: new Date(0).toISOString()
  };
  const replacement = { ...registration, socketPath: "/tmp/new.sock", pid: process.pid, registeredAt: new Date().toISOString() };
  await fs.writeFile(registrationPath(directory, registration.id), JSON.stringify(replacement));
  assert.deepEqual(await waitForReplacementRegistration(registration, 100, directory), replacement);
  await fs.writeFile(registrationPath(directory, registration.id), JSON.stringify({ ...replacement, workspace: "/other" }));
  assert.equal(await waitForReplacementRegistration(registration, 20, directory), undefined);
  await fs.rm(directory, { recursive: true });
});

test("processExists returns true for current process", () => {
  const result = processExists(process.pid);
  assert.equal(result, true);
});

// Helper function - same as in hangup_detector.ts
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
