export type TerminalColor = "red" | "green" | "yellow" | "cyan" | "gray";

const codes: Record<TerminalColor, number> = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 };

export function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb");
}

export function color(text: string, tone: TerminalColor, enabled = supportsColor()): string {
  return enabled ? `\u001b[${codes[tone]}m${text}\u001b[0m` : text;
}

export function bold(text: string, enabled = supportsColor()): string {
  return enabled ? `\u001b[1m${text}\u001b[0m` : text;
}

export function stateColor(state: string): TerminalColor {
  if (state === "completed") return "green";
  if (state === "failed" || state === "error" || state === "unavailable") return "red";
  if (state === "running" || state === "waiting" || state === "active" || state === "submitted") return "yellow";
  if (state === "queued") return "cyan";
  return "gray";
}
