export function taskTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const phase = lines.find(line => /^#*\s*PHASE\b/i.test(line));
  if (phase) return phase;
  return lines.find(line => !/^#?\s*[-=_*]{3,}\s*$/.test(line));
}
