import assert from "node:assert/strict";
import test from "node:test";
import { parseWaitingTaskChoice } from "../src/client/commands/waiting_task_prompt";

test("waiting-task prompt accepts resume, skip, and abort choices", () => {
  assert.equal(parseWaitingTaskChoice("1"), "resume");
  assert.equal(parseWaitingTaskChoice("resume"), "resume");
  assert.equal(parseWaitingTaskChoice("2"), "skip");
  assert.equal(parseWaitingTaskChoice("SKIP"), "skip");
  assert.equal(parseWaitingTaskChoice("3"), "abort");
  assert.equal(parseWaitingTaskChoice(""), undefined);
});
