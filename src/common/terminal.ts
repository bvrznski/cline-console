export type TerminalColor = "red" | "green" | "yellow" | "cyan" | "magenta" | "gray";

const codes: Record<TerminalColor, number> = { red: 31, green: 32, yellow: 33, cyan: 36, magenta: 35, gray: 90 };

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
  if (state === "completed" || state === "closed") return "green";
  if (state === "failed" || state === "error" || state === "unavailable") return "red";
  if (state === "running" || state === "waiting" || state === "active" || state === "submitted") return "yellow";
  if (state === "interrupted") return "magenta";
  if (state === "queued") return "cyan";
  return "gray";
}

let commandOutputColors = false;
let commandOutputInstalled = false;

export function configureCommandOutput(json: boolean, noColor = false): void {
  commandOutputColors = !json && !noColor && supportsColor();
  if (commandOutputInstalled) return;
  commandOutputInstalled = true;
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const rendered = typeof chunk === "string" ? colorizeCommandOutput(chunk) : chunk;
    return Reflect.apply(originalWrite, process.stdout, [rendered, ...args]) as boolean;
  }) as typeof process.stdout.write;
}

export function colorizeCommandOutput(text: string, enabled = commandOutputColors): string {
  if (!enabled || text.includes("\u001b[")) return text;
  return text.split("\n").map(line => {
    if (!line) return line;
    if (/^(Usage|Options):$/.test(line)) return bold(color(line, "cyan", true), true);
    if (/^(Warning:|Aborted\.|Incomplete task|Duplicate task)/i.test(line)) return color(line, "yellow", true);
    if (/successfully|preserved|installed|started|resumed|sent to completed|removed:/i.test(line)) return colorizeLabel(line, "green");
    const match = line.match(/^([^:]{1,40}):(\s*)(.*)$/);
    if (match) return `${bold(match[1] + ":", true)}${match[2]}${color(match[3], valueTone(match[3]), true)}`;
    if (/^\s{2}(?:cline-console|--|-\w)/.test(line)) return color(line, "cyan", true);
    return line;
  }).join("\n");
}

function colorizeLabel(line: string, tone: TerminalColor): string {
  const match = line.match(/^([^:]+):(\s*)(.*)$/);
  return match ? `${bold(match[1] + ":", true)}${match[2]}${color(match[3], tone, true)}` : color(line, tone, true);
}

function valueTone(value: string): TerminalColor {
  if (/\b(?:failed|stopped|unavailable|error)\b/i.test(value)) return "red";
  if (/\b(?:interrupted)\b/i.test(value)) return "magenta";
  if (/\b(?:running|waiting|paused|skipped|nothing to resume)\b/i.test(value)) return "yellow";
  if (/\b(?:completed|connected|preserved|resumed|yes)\b/i.test(value)) return "green";
  return "cyan";
}
