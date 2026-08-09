import assert from "node:assert/strict";
import test from "node:test";
import { parseActiveTaskChoice } from "../src/client/commands/active_task_prompt";

test("active-task prompt accepts numbered and named choices", () => {
  assert.equal(parseActiveTaskChoice("1"), "queue");
  assert.equal(parseActiveTaskChoice("queue"), "queue");
  assert.equal(parseActiveTaskChoice("2"), "replace");
  assert.equal(parseActiveTaskChoice("interrupt"), "replace");
  assert.equal(parseActiveTaskChoice("3"), "abort");
});

test("active-task prompt rejects invalid choices", () => assert.equal(parseActiveTaskChoice("continue"), undefined));
