import assert from "node:assert/strict";
import test from "node:test";
import { hasExplicitRemainingWork } from "../src/integrations/cline/remaining_work";

test("remaining-work detector recognizes explicit unfinished sections", () => {
  assert.equal(hasExplicitRemainingWork("## Remaining work\n- Add integration tests\n- Update docs"), true);
  assert.equal(hasExplicitRemainingWork("**Remaining Implementation Required:**\nConcrete adapters and comprehensive tests"), true);
  assert.equal(hasExplicitRemainingWork("Remaining tasks: validate the runtime"), true);
});

test("remaining-work detector ignores explicit empty sections and prose mentions", () => {
  assert.equal(hasExplicitRemainingWork("## Remaining work\nNone."), false);
  assert.equal(hasExplicitRemainingWork("Remaining: N/A"), false);
  assert.equal(hasExplicitRemainingWork("All requested work is complete; no remaining work exists."), false);
  assert.equal(hasExplicitRemainingWork("The remaining work detector was implemented."), false);
  assert.equal(hasExplicitRemainingWork("Remaining work detector behavior is covered."), false);
  assert.equal(hasExplicitRemainingWork("## Remaining work\n\n## Validation\nAll tests passed"), false);
});
