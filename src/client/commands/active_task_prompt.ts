import { createInterface } from "node:readline/promises";

export type ActiveTaskChoice = "queue" | "replace" | "abort";

export function parseActiveTaskChoice(value: string): ActiveTaskChoice | undefined {
  switch (value.trim().toLowerCase()) {
    case "1": case "queue": return "queue";
    case "2": case "replace": case "interrupt": return "replace";
    case "3": case "abort": return "abort";
    default: return undefined;
  }
}

export async function promptForActiveTaskChoice(timeoutMs = 30_000): Promise<ActiveTaskChoice> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "abort";
  process.stdout.write("An active Cline task exists in this workspace.\n\n  1) Add the new task to the queue\n  2) Interrupt the current task and replace it\n  3) Abort\n\n");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let timer: NodeJS.Timeout | undefined;
  const deadline = Date.now() + timeoutMs;
  const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const question = readline.question(`Choose within ${timeoutSeconds} seconds [1-3]: `).catch(() => "");
      const timeout = new Promise<string>(resolve => { timer = setTimeout(() => resolve(""), remaining); });
      const answer = await Promise.race([question, timeout]);
      if (timer) { clearTimeout(timer); timer = undefined; }
      const choice = parseActiveTaskChoice(answer);
      if (choice) return choice;
      if (!answer) return "abort";
      process.stdout.write("Invalid choice. Enter 1, 2, or 3.\n");
    }
    return "abort";
  } finally {
    if (timer) clearTimeout(timer);
    readline.close();
  }
}
