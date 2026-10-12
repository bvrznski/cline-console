import assert from "node:assert/strict";
import test from "node:test";
import { parseDuplicateTaskConfirmation } from "../src/client/commands/duplicate_task_prompt";

test("duplicate-task confirmation accepts only an explicit yes", () => {
  assert.equal(parseDuplicateTaskConfirmation("y"), true);
  assert.equal(parseDuplicateTaskConfirmation("YES"), true);
  assert.equal(parseDuplicateTaskConfirmation(""), false);
  assert.equal(parseDuplicateTaskConfirmation("no"), false);
});
