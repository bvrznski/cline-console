import assert from "node:assert/strict";
import test from "node:test";
import { findLatestContextOverflow } from "../src/integrations/cline/context_overflow";

test("context-overflow detector recognizes explicit provider errors", () => {
  assert.deepEqual(findLatestContextOverflow([
    { ts: 42, type: "say", say: "error", text: "maximum context length exceeded" }
  ], "task-1"), { marker: "task-1:42" });
  assert.deepEqual(findLatestContextOverflow([
    { type: "say", say: "api_req_failed", text: "context_length_exceeded" }
  ], "task-2"), { marker: "task-2:0" });
});

test("context-overflow detector ignores telemetry and ordinary prose", () => {
  assert.equal(findLatestContextOverflow([
    { type: "say", say: "api_req_started", text: "Context Window Usage: 200,000 / 262,144 tokens" },
    { type: "say", say: "text", text: "The context window implementation is complete." }
  ], "task"), undefined);
});
