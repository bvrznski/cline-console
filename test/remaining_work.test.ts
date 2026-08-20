import assert from "node:assert/strict";
import test from "node:test";
import { auditCompletionReport, auditTaskProgress, extractRemainingSteps, hasExplicitRemainingWork } from "../src/integrations/cline/remaining_work";

test("remaining-work detector recognizes explicit unfinished sections", () => {
  assert.equal(hasExplicitRemainingWork("## Remaining work\n- Add integration tests\n- Update docs"), true);
  assert.equal(hasExplicitRemainingWork("**Remaining Implementation Required:**\nConcrete adapters and comprehensive tests"), true);
  assert.equal(hasExplicitRemainingWork("Remaining tasks: validate the runtime"), true);
  assert.equal(hasExplicitRemainingWork("### Remaining Stages (Future Work):\n- Stage 4-8: Implement the full engine"), true);
  assert.equal(hasExplicitRemainingWork("## Future Work\n- Add end-to-end validation"), true);
  assert.equal(hasExplicitRemainingWork("**Outstanding items:** finish migration"), true);
  assert.equal(hasExplicitRemainingWork("Status: PARTIAL"), true);
  assert.equal(hasExplicitRemainingWork("IMPLEMENTATION INCOMPLETE"), true);
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
  assert.deepEqual(extractRemainingSteps("All work complete", "7/14 complete"), ["Identify and complete the 7 steps still missing from task_progress (7/14 complete)"]);
});
