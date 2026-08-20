import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCommand, parseArgs, summarizeInvocation } from "../src/client/cli";

test("CLI parses global workspace before command", () => {
  assert.deepEqual(parseArgs(["--workspace", "/repo", "new", "-f", "task.md"]), { workspace: "/repo", json: false, command: "new", commandArgs: ["-f", "task.md"] });
});

test("CLI parses JSON status", () => assert.equal(parseArgs(["status", "--json"]).json, true));

test("CLI parses workspace after command", () => {
  assert.deepEqual(parseArgs(["tasks", "--workspace", "/repo", "--json"]), { workspace: "/repo", json: true, command: "tasks", commandArgs: [] });
});

test("CLI parses task control operations", () => {
  assert.deepEqual(parseArgs(["--workspace", "/repo", "tasks", "stop"]), { workspace: "/repo", json: false, command: "tasks", commandArgs: ["stop"] });
  assert.deepEqual(parseArgs(["--workspace", "/repo", "tasks", "reload"]), { workspace: "/repo", json: false, command: "tasks", commandArgs: ["reload"] });
});

test("CLI parses queue pop selector as one argument", () => {
  assert.deepEqual(parseArgs(["--workspace", "/repo", "queue", "pop", "Displayed title"]), { workspace: "/repo", json: false, command: "queue", commandArgs: ["pop", "Displayed title"] });
});

test("CLI parses standalone resume with task files", () => {
  assert.deepEqual(parseArgs(["--workspace", "/repo", "resume", "-f", "one.md", "two.md"]), { workspace: "/repo", json: false, command: "resume", commandArgs: ["-f", "one.md", "two.md"] });
  assert.deepEqual(parseArgs(["--workspace", "/repo", "resume"]), { workspace: "/repo", json: false, command: "resume", commandArgs: [] });
});

test("CLI log summary never contains inline prompt text", () => {
  const summary = summarizeInvocation(["--workspace", "/secret/repo", "new", "private prompt text"]);
  assert.equal(summary, "CLI invoked: command=new workspace=specified argumentCount=1 json=false");
  assert.doesNotMatch(summary, /private prompt|secret/);
});

test("CLI parses global display and timeout options anywhere", () => {
  assert.deepEqual(parseArgs(["task", "status", "--workspace", "/repo", "--json", "--no-color", "--timeout", "12"]), {
    workspace: "/repo", json: true, noColor: true, timeoutMs: 12_000, command: "task", commandArgs: ["status"]
  });
  assert.equal(parseArgs(["-V"]).command, "version");
  assert.equal(parseArgs(["queue", "add", "--help"]).command, "help");
});

test("canonical task grammar normalizes to existing execution commands", () => {
  assert.equal(normalizeCommand(parseArgs(["task", "start", "--file", "task.md"])).parsed.command, "new");
  assert.deepEqual(normalizeCommand(parseArgs(["task", "send", "--text", "Continue"])).parsed.commandArgs, ["Continue"]);
  assert.deepEqual(normalizeCommand(parseArgs(["task", "restart"])).parsed.commandArgs, ["reload"]);
  assert.deepEqual(normalizeCommand(parseArgs(["task", "finish"])).parsed.commandArgs, ["finish"]);
  assert.throws(() => normalizeCommand(parseArgs(["task", "start", "--file", "one", "two"])), /exactly one/);
});

test("canonical queue grammar preserves batches and explicit selectors", () => {
  const add = normalizeCommand(parseArgs(["queue", "add", "--file", "one", "two", "--resume"])).parsed;
  assert.equal(add.command, "add");
  assert.deepEqual(add.commandArgs, ["--file", "one", "two"]);
  assert.equal(add.resumeAfter, true);
  assert.deepEqual(normalizeCommand(parseArgs(["queue", "replace", "--dir", "tasks"])).parsed.commandArgs, ["--dir", "tasks"]);
  assert.deepEqual(normalizeCommand(parseArgs(["queue", "remove", "--id", "abc"])).parsed.commandArgs, ["pop", "abc", "id"]);
  assert.deepEqual(normalizeCommand(parseArgs(["queue", "clear", "--force"])).parsed.commandArgs, ["clear", "--force"]);
});

test("workspace clear normalizes to the destructive scoped operation", () => {
  assert.deepEqual(normalizeCommand(parseArgs(["-w", "/repo", "workspace", "clear"])).parsed, { workspace: "/repo", json: false, command: "workspaceClear", commandArgs: [] });
});

test("legacy commands retain behavior with deprecation guidance", () => {
  assert.match(normalizeCommand(parseArgs(["add", "-f", "task.md"])).warning ?? "", /queue add/);
  assert.match(normalizeCommand(parseArgs(["queue"])).warning ?? "", /queue list/);
  assert.equal(normalizeCommand(parseArgs(["tasks"])).warning, undefined);
  assert.match(normalizeCommand(parseArgs(["task", "list"])).warning ?? "", /use 'tasks'/);
});
