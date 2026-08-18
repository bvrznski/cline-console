const REMAINING_LINE = /^remaining(?:\s+(?:work|tasks?|implementation|required work|items?))?(?:\s+required)?(?:\s*:\s*(.*))?$/i;
const EMPTY_REMAINDER = /^(?:none|nothing|n\/?a|not applicable|no(?:ne)? remaining(?: work| tasks?| items?)?|complete(?:d)?|all (?:done|complete(?:d)?))\.?$/i;

export function hasExplicitRemainingWork(text: string | undefined): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const normalizedLine = lines[index].trim().replace(/^#{1,6}\s*/, "").replace(/\*\*|__/g, "").trim();
    const remaining = normalizedLine.match(REMAINING_LINE);
    if (!remaining) continue;
    if (remaining[1]?.trim()) return isWorkContent(remaining[1]);
    const content: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (/^\s*#{1,6}\s+/.test(line)) break;
      content.push(line);
    }
    return isWorkContent(content.join("\n"));
  }
  return false;
}

function isWorkContent(value: string): boolean {
  const normalized = value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`]/g, "")
    .trim();
  return normalized.length > 0 && !EMPTY_REMAINDER.test(normalized);
}
