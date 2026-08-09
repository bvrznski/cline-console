import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, summarizeInvocation } from "../src/client/cli";

test("CLI parses global workspace before command", () => {
  assert.deepEqual(parseArgs(["--workspace", "/repo", "new", "-f", "task.md"]), { workspace: "/repo", json: false, command: "new", commandArgs: ["-f", "task.md"] });
});

test("CLI parses JSON status", () => assert.equal(parseArgs(["status", "--json"]).json, true));

test("CLI parses workspace after command", () => {
  assert.deepEqual(parseArgs(["tasks", "--workspace", "/repo", "--json"]), { workspace: "/repo", json: true, command: "tasks", commandArgs: [] });
});

test("CLI log summary never contains inline prompt text", () => {
  const summary = summarizeInvocation(["--workspace", "/secret/repo", "new", "private prompt text"]);
  assert.equal(summary, "CLI invoked: command=new workspace=specified argumentCount=1 json=false");
  assert.doesNotMatch(summary, /private prompt|secret/);
});
