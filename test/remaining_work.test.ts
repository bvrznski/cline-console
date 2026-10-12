import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { auditCompletionReport, auditTaskProgress, extractAuditRecommendations, extractRemainingSteps, hasExplicitRemainingWork } from "../src/integrations/cline/remaining_work";

// Create a temporary directory for testing
test("explicit later-phase ledger does not reopen a completed task", () => {
  const ledger = "## Deferred Work Ledger\nWork intentionally deferred to later phases\n### Next Steps\n- [ ] Implement phase 2\n### Recommendations\n- Implement future API";
  assert.equal(auditCompletionReport(ledger).requiresContinuation, false);
  assert.equal(auditTaskProgress(ledger).requiresContinuation, false);
  assert.deepEqual(extractRemainingSteps(ledger, ledger), []);
  assert.deepEqual(extractAuditRecommendations("audit", ledger), []);
  assert.equal(auditCompletionReport(ledger + "\n## Remaining Work\n- Fix current tests").requiresContinuation, true);
  assert.equal(auditCompletionReport(ledger, "- [ ] Current requirement").requiresContinuation, true);
  assert.equal(auditCompletionReport(ledger.replace("Work intentionally deferred to later phases", "Unfinished implementation")).requiresContinuation, true);
  assert.equal(auditCompletionReport(ledger + "\nThis task is incomplete").requiresContinuation, true);
});

function createTempDir(name: string): string {
  const tempDir = path.join("/tmp", `test-cline-${name}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

test("remaining-work detector recognizes explicit unfinished sections", () => {
  assert.equal(hasExplicitRemainingWork("## Remaining work\n- Add integration tests\n- Update docs"), true);
  assert.equal(hasExplicitRemainingWork("**Remaining Implementation Required:**\nConcrete adapters and comprehensive tests"), true);
  assert.equal(hasExplicitRemainingWork("Remaining tasks: validate the runtime"), true);
  assert.equal(hasExplicitRemainingWork("### Remaining Stages (Future Work):\n- Stage 4-8: Implement the full engine"), true);
  assert.equal(hasExplicitRemainingWork("## Future Work\n- Add end-to-end validation"), true);
  assert.equal(hasExplicitRemainingWork("**Outstanding items:** finish migration"), true);
  assert.equal(hasExplicitRemainingWork("Remaining further enhancements\n- Add cancellation coverage\n- Harden cleanup"), true);
  assert.equal(hasExplicitRemainingWork("Remaining further steps\n1. Run integration tests\n2. Update the report"), true);
  assert.equal(hasExplicitRemainingWork("### Next Steps\n1. Build and test native code integration\n2. Migrate callers\n3. Retire superseded Python code"), true);
  assert.equal(hasExplicitRemainingWork("Status: PARTIAL"), true);
  assert.equal(hasExplicitRemainingWork("IMPLEMENTATION INCOMPLETE"), true);
  assert.equal(hasExplicitRemainingWork("**To achieve R4-R7 (Full Production Readiness)**:\n1. Integrate health monitors\n2. Run extended soak tests"), true);
  assert.equal(auditCompletionReport(undefined).requiresContinuation, false);
});

test("task-progress detector recognizes incomplete checkbox and ratio counters", () => {
  assert.equal(auditTaskProgress("- [x] Analyze\n- [x] Implement\n- [ ] Test\n- [ ] Document").reason, "task progress incomplete: 2/4 complete");
  assert.equal(auditTaskProgress("4/13 Implement stakeholders module").requiresContinuation, true);
  assert.equal(auditTaskProgress("13/13 Complete").requiresContinuation, false);
  assert.equal(auditTaskProgress("- [x] Analyze\n- [x] Implement").requiresContinuation, false);
  assert.equal(auditCompletionReport("All work complete", "4/13 Implement stakeholders module").requiresContinuation, true);
});

test("remaining-work detector ignores explicit empty sections and prose mentions", () => {
  assert.equal(hasExplicitRemainingWork("## Remaining work\nNone."), false);
  assert.equal(hasExplicitRemainingWork("Remaining: N/A"), false);
  assert.equal(hasExplicitRemainingWork("All requested work is complete; no remaining work exists."), false);
  assert.equal(hasExplicitRemainingWork("The remaining work detector was implemented."), false);
  assert.equal(hasExplicitRemainingWork("Remaining work detector behavior is covered."), false);
  assert.equal(hasExplicitRemainingWork("The remaining further enhancements detector is covered."), false);
  assert.equal(hasExplicitRemainingWork("## Remaining work\n\n## Validation\nAll tests passed"), false);
  assert.equal(hasExplicitRemainingWork("## Future Work\nNone\n\n## Validation\nAll tests passed"), false);
  assert.equal(hasExplicitRemainingWork(undefined), false);
});

test("remaining-work parser extracts concrete steps from progress and completion reports", () => {
  assert.deepEqual(extractRemainingSteps(
    "## Remaining work\n- Add integration tests\n2. Validate runtime startup\n\n## Validation\nNot run",
    "- [x] Inspect\n- [ ] Fix serialization\n- [ ] Add integration tests"
  ), ["Fix serialization", "Add integration tests", "Validate runtime startup"]);
  assert.deepEqual(extractRemainingSteps("Remaining tasks: validate the runtime"), ["validate the runtime"]);
  assert.deepEqual(extractRemainingSteps("Remaining further enhancements\n- Add cancellation coverage\n2. Harden cleanup"), ["Add cancellation coverage", "Harden cleanup"]);
  assert.deepEqual(extractRemainingSteps("Remaining further steps\n- Verify every completion criterion"), ["Verify every completion criterion"]);
  assert.deepEqual(extractRemainingSteps("### Next Steps\n1. Build and test native code integration\n2. Migrate callers"), ["Build and test native code integration", "Migrate callers"]);
  assert.deepEqual(extractRemainingSteps("**To achieve R4-R7**:\n1. Integrate the runtime\n2. Run the real soak profile"), ["Integrate the runtime", "Run the real soak profile"]);
  assert.deepEqual(extractRemainingSteps("All work complete", "7/14 complete"), ["Identify and complete the 7 steps still missing from task_progress (7/14 complete)"]);
});

test("audit recommendation parser extracts actionable lists only for audit tasks", () => {
  const report = "## Recommended Next Actions\n1. Restrict SSH access\n2. Add regression tests\n\n## Evidence\nCollected locally";
  assert.deepEqual(extractAuditRecommendations("Perform a security audit", report), ["Restrict SSH access", "Add regression tests"]);
  assert.deepEqual(extractAuditRecommendations("Implement a feature", report), []);
  assert.deepEqual(extractAuditRecommendations("Perform a code review", "## Recommendations\nNone"), []);
  assert.deepEqual(extractAuditRecommendations("Run an assessment", "Recommendations: rotate credentials"), ["rotate credentials"]);
});

test("directory structure validation detects invalid L1 directories", () => {
  const tempDir = createTempDir("invalid-dirs");
  try {
    // Create core directory with invalid structures
    const coreDir = path.join(tempDir, "src/agent/components/core");
    fs.mkdirSync(coreDir, { recursive: true });

    // Add an agency subdirectory (should trigger warning)
    fs.mkdirSync(path.join(coreDir, "agency"));

    // Test that directory structure audit detects invalid L1 directories
    const result = auditCompletionReport("Task completed successfully", undefined, { workspacePath: tempDir });
    assert.equal(result.requiresContinuation, true);
    assert.ok(result.reason.includes("invalid directory structure") || result.reason.includes("agency/ directory"));
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("directory structure validation detects missing canonical directories", () => {
  const tempDir = createTempDir("missing-canonical");
  try {
    // Create core directory with only a few canonical dirs
    const coreDir = path.join(tempDir, "src/agent/components/core");
    fs.mkdirSync(coreDir, { recursive: true });

    // Add only 2 canonical directories (should trigger warning for missing)
    fs.mkdirSync(path.join(coreDir, "architecture"));
    fs.mkdirSync(path.join(coreDir, "execution"));

    // Test that directory structure audit detects incomplete canonical structure
    const result = auditCompletionReport("Task completed successfully", undefined, { workspacePath: tempDir });
    assert.equal(result.requiresContinuation, true);
    assert.ok(result.reason.includes("incomplete canonical structure") || result.reason.includes("canonical L1 directories"));
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("directory structure validation with complete structure passes", () => {
  const tempDir = createTempDir("complete-structure");
  try {
    // Create core directory with most canonical dirs
    const coreDir = path.join(tempDir, "src/agent/components/core");
    fs.mkdirSync(coreDir, { recursive: true });

    // Add most canonical directories (9 total)
    const canonicalDirs = ["architecture", "communication", "control", "execution", "lifecycle", "platform", "resilience", "runtime", "state"];
    for (const dir of canonicalDirs) {
      fs.mkdirSync(path.join(coreDir, dir));
    }

    // Test that directory structure audit passes with complete structure
    const result = auditCompletionReport("Task completed successfully", undefined, { workspacePath: tempDir });
    assert.equal(result.requiresContinuation, false);
    assert.ok(result.reason.includes("no unfinished-work declarations"));
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("apparent completion detection flags false completion claims", () => {
  const tempDir = createTempDir("false-completion");
  try {
    // Create core directory with agency subdirectory
    const coreDir = path.join(tempDir, "src/agent/components/core");
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(path.join(coreDir, "agency"));

    // Test that completion claim + structural issues triggers warning
    const result = auditCompletionReport("Task is complete - all work finished", undefined, { workspacePath: tempDir });
    assert.equal(result.requiresContinuation, true);
  } finally {
    cleanupTempDir(tempDir);
  }
});
