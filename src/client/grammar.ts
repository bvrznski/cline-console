export interface Parsed {
  workspace?: string;
  json: boolean;
  noColor?: boolean;
  timeoutMs?: number;
  command?: string;
  commandArgs: string[];
  resumeAfter?: boolean;
}

export interface NormalizedCommand { parsed: Parsed; warning?: string; }

export function parseArgs(argv: string[]): Parsed {
  let workspace: string | undefined, json = false, noColor = false, timeoutMs: number | undefined, command: string | undefined;
  const commandArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") { workspace = argv[++i]; if (!workspace) throw new Error("--workspace requires a path."); continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--no-color") { noColor = true; continue; }
    if (arg === "--timeout") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout requires a positive number of seconds.");
      timeoutMs = value * 1_000;
      continue;
    }
    if (arg === "--version" || arg === "-V") return { workspace, json, ...(noColor ? { noColor } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), command: "version", commandArgs: [] };
    if (arg === "--help" || arg === "-h") return { workspace, json, ...(noColor ? { noColor } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), command: "help", commandArgs: [] };
    if (!command) command = arg; else commandArgs.push(arg);
  }
  return { workspace, json, ...(noColor ? { noColor } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), command, commandArgs };
}

export function normalizeCommand(input: Parsed): NormalizedCommand {
  const args = [...input.commandArgs];
  if (input.command === "task") {
    const action = args.shift() ?? "status";
    if (action === "list") return { parsed: { ...input, command: "tasks", commandArgs: args }, warning: "'task list' is deprecated; use 'tasks'." };
    if (action === "status" || action === "capabilities") {
      if (args.length) throw new Error(`task ${action} accepts no arguments.`);
      return { parsed: { ...input, command: action, commandArgs: [] } };
    }
    if (action === "send") return { parsed: { ...input, command: action, commandArgs: normalizeTextArgs(action, args) } };
    if (action === "start") {
      if (args.includes("-d") || args.includes("--dir") || args.includes("--directory")) throw new Error("task start accepts one file, text, or stdin; use queue add for batches and directories.");
      const marker = args.findIndex(arg => arg === "-f" || arg === "--file");
      if (marker >= 0 && args.slice(marker + 1).length !== 1) throw new Error("task start accepts exactly one task file; use queue add for batches.");
      return { parsed: { ...input, command: "new", commandArgs: normalizeTextArgs(action, args) } };
    }
    if (action === "stop") return { parsed: { ...input, command: "tasks", commandArgs: ["stop", ...args] } };
    if (action === "restart") return { parsed: { ...input, command: "tasks", commandArgs: ["reload", ...args] } };
    throw new Error(`Unknown task action: ${action}`);
  }
  if (input.command === "workspace") {
    const action = args.shift();
    if (action === "list" && !args.length) return { parsed: { ...input, command: "workspaces", commandArgs: [] } };
    if (action === "clear" && !args.length) return { parsed: { ...input, command: "workspaceClear", commandArgs: [] } };
    throw new Error("Usage: cline-console workspace list|clear");
  }
  if (input.command === "queue") {
    const action = args[0];
    if (action === "list") return { parsed: { ...input, commandArgs: args.slice(1) } };
    if (action === "add") {
      const actionArgs = args.slice(1), resumeAfter = removeFlag(actionArgs, "--resume");
      return { parsed: { ...input, command: "add", commandArgs: actionArgs, ...(resumeAfter ? { resumeAfter: true } : {}) } };
    }
    if (action === "replace") return { parsed: { ...input, command: "replace", commandArgs: args.slice(1) } };
    if (action === "remove") {
      const selectorArgs = args.slice(1);
      if (selectorArgs.length !== 2 || !(selectorArgs[0] === "--file" || selectorArgs[0] === "--title" || selectorArgs[0] === "--id")) {
        throw new Error("queue remove requires exactly one of --file PATH, --title TITLE, or --id ID.");
      }
      return { parsed: { ...input, commandArgs: ["pop", selectorArgs[1], selectorArgs[0].slice(2)] } };
    }
    if (action === "pop") return { parsed: input, warning: "'queue pop' is deprecated; use 'queue remove --file|--title|--id'." };
    if (!action) return { parsed: input, warning: "'queue' without an action is deprecated; use 'queue list'." };
    return { parsed: input };
  }
  const replacements: Record<string, string> = {
    new: "task start", send: "task send", cancel: "task stop", status: "task status",
    add: "queue add", resume: "queue resume", workspaces: "workspace list", list: "workspace list", capabilities: "task capabilities"
  };
  const replacement = input.command ? replacements[input.command] : undefined;
  return { parsed: input, ...(replacement ? { warning: `'${input.command}' is deprecated; use '${replacement}'.` } : {}) };
}

function normalizeTextArgs(action: string, args: string[]): string[] {
  if (args[0] === "--text" || args[0] === "-t") {
    if (args.length !== 2) throw new Error(`task ${action} --text requires exactly one text argument.`);
    return [args[1]];
  }
  if (args[0] === "--stdin") {
    if (args.length !== 1) throw new Error(`task ${action} --stdin accepts no additional arguments.`);
    return ["-"];
  }
  return args;
}

function removeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  if (args.includes(flag)) throw new Error(`${flag} may be specified only once.`);
  return true;
}
