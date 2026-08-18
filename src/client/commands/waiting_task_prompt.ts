import { createInterface } from "node:readline/promises";

export type WaitingTaskChoice = "resume" | "skip" | "abort";

export function parseWaitingTaskChoice(value: string): WaitingTaskChoice | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "resume") return "resume";
  if (normalized === "2" || normalized === "skip") return "skip";
  if (normalized === "3" || normalized === "abort") return "abort";
  return undefined;
}

export async function promptForWaitingTaskChoice(timeoutMs = 30_000): Promise<WaitingTaskChoice> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "abort";
  process.stdout.write("The current Cline task is incomplete and waiting for resume:\n\n  1) Resume it from its original prompt, then add files to the queue\n  2) Skip it and add files to the queue\n  3) Abort\n\n");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"abort">(resolve => { timer = setTimeout(() => resolve("abort"), timeoutMs); });
  try {
    while (true) {
      const answer = await Promise.race([readline.question(`Select an option (${timeoutSeconds} second timeout): `), timeout]);
      if (answer === "abort") return "abort";
      const choice = parseWaitingTaskChoice(answer);
      if (choice) return choice;
      process.stdout.write("Enter 1, 2, or 3.\n");
    }
  } catch { return "abort"; }
  finally { if (timer) clearTimeout(timer); readline.close(); }
}
