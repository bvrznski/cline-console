import { createInterface } from "node:readline/promises";

export function parseDuplicateTaskConfirmation(value: string): boolean {
  return value.trim().toLowerCase() === "y" || value.trim().toLowerCase() === "yes";
}

export async function promptForDuplicateTaskConfirmation(message: string, timeoutMs = 15_000): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  process.stdout.write(`${message}\n`);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<string>(resolve => { timer = setTimeout(() => resolve(""), timeoutMs); });
    const answer = await Promise.race([readline.question(`Add duplicate anyway? [y/N] (${Math.ceil(timeoutMs / 1_000)} second timeout): `), timeout]);
    return parseDuplicateTaskConfirmation(answer);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    readline.close();
  }
}
