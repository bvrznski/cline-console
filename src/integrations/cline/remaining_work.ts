const UNFINISHED_LABEL = /^(?:remaining\b.*|outstanding\b.*|pending\b.*|future work|next steps?|todos?|open (?:items?|work)|deferred (?:items?|work)|unimplemented (?:items?|work|features?)|incomplete (?:items?|work|stages?|implementation))$/i;
const INCOMPLETE_STATUS = /^(?:final |completion )?status\s*:\s*(?:partial(?:ly complete)?|incomplete|blocked|not complete|requires? (?:work|completion))\b/i;
const INCOMPLETE_CERTIFICATION = /\b(?:capability|implementation|migration|task|phase)\s+(?:is\s+)?(?:partial|incomplete|blocked)\s*$/i;
const EMPTY_REMAINDER = /^(?:none|nothing|n\/?a|not applicable|no(?:ne)? remaining(?: work| tasks?| items?| stages?| steps?)?|complete(?:d)?|all (?:done|complete(?:d)?))\.?$/i;
const AUDIT_TASK = /\b(?:audit|auditing|assessment|inspection|compliance review|security review|code review)\b/i;
const RECOMMENDATION_LABEL = /^(?:recommended (?:next )?actions?|recommendations?|remediation(?: recommendations?| actions?)?|proposed (?:improvements?|actions?|remediations?))$/i;

export interface CompletionAudit { requiresContinuation: boolean; reason: string; }

export function auditCompletionReport(text: string | undefined, taskProgressText?: string): CompletionAudit {
  const progress = auditTaskProgress(taskProgressText);
  if (progress.requiresContinuation) return progress;
  if (!text?.trim()) return { requiresContinuation: false, reason: "completion report body is missing; no explicit unfinished-work declaration found" };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const markdownHeading = /^#{1,6}\s+/.test(trimmed);
    const boldHeading = /^(?:\*\*|__).+(?:\*\*|__)$/.test(trimmed);
    const normalized = trimmed.replace(/^#{1,6}\s*/, "").replace(/\*\*|__/g, "").trim();
    if (INCOMPLETE_STATUS.test(normalized) || INCOMPLETE_CERTIFICATION.test(normalized)) {
      return { requiresContinuation: true, reason: `incomplete status declaration: ${normalized}` };
    }
    const colon = normalized.indexOf(":");
    const label = (colon >= 0 ? normalized.slice(0, colon) : normalized).replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!(markdownHeading || boldHeading || colon >= 0) || !UNFINISHED_LABEL.test(label)) continue;
    const inline = colon >= 0 ? normalized.slice(colon + 1) : "";
    if (isWorkContent(inline)) return { requiresContinuation: true, reason: `unfinished section: ${label}` };
    const content: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (/^\s*#{1,6}\s+/.test(line)) break;
      content.push(line);
    }
    if (isWorkContent(content.join("\n"))) return { requiresContinuation: true, reason: `unfinished section: ${label}` };
  }
  return { requiresContinuation: false, reason: "completion report contains no unfinished-work declarations" };
}

export function auditTaskProgress(text: string | undefined): CompletionAudit {
  if (!text?.trim()) return { requiresContinuation: false, reason: "task progress is unavailable" };
  const checkboxes = [...text.matchAll(/^\s*[-*+]\s+\[([ xX])\]/gm)];
  if (checkboxes.length) {
    const completed = checkboxes.filter(match => match[1].toLowerCase() === "x").length;
    if (completed < checkboxes.length) return { requiresContinuation: true, reason: `task progress incomplete: ${completed}/${checkboxes.length} complete` };
    return { requiresContinuation: false, reason: `task progress complete: ${completed}/${checkboxes.length}` };
  }
  const ratio = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (ratio) {
    const completed = Number(ratio[1]), total = Number(ratio[2]);
    if (total > 0 && completed >= 0 && completed < total) return { requiresContinuation: true, reason: `task progress incomplete: ${completed}/${total} complete` };
  }
  return { requiresContinuation: false, reason: "task progress contains no incomplete counter" };
}

export function hasExplicitRemainingWork(text: string | undefined, taskProgressText?: string): boolean {
  return auditCompletionReport(text, taskProgressText).requiresContinuation;
}

export function extractRemainingSteps(completionText?: string, taskProgressText?: string): string[] {
  const steps: string[] = [];
  for (const match of (taskProgressText ?? "").matchAll(/^\s*[-*+]\s+\[ \]\s+(.+)$/gm)) addStep(steps, match[1]);
  const lines = (completionText ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseUnfinishedHeading(lines[index]);
    if (!parsed) continue;
    if (isWorkContent(parsed.inline)) addStep(steps, parsed.inline);
    for (index += 1; index < lines.length; index += 1) {
      if (isSectionHeading(lines[index])) { index -= 1; break; }
      const item = cleanWorkItem(lines[index]);
      if (item && isWorkContent(item)) addStep(steps, item);
    }
  }
  if (!steps.length) {
    const ratio = (taskProgressText ?? "").match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (ratio && Number(ratio[2]) > Number(ratio[1])) steps.push(`Identify and complete the ${Number(ratio[2]) - Number(ratio[1])} steps still missing from task_progress (${ratio[1]}/${ratio[2]} complete)`);
  }
  return steps.slice(0, 50);
}

export function extractAuditRecommendations(taskPrompt: string | undefined, completionText: string | undefined): string[] {
  if (!completionText?.trim() || !AUDIT_TASK.test(`${taskPrompt ?? ""}\n${completionText}`)) return [];
  const recommendations: string[] = [];
  const lines = completionText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseRecommendationHeading(lines[index]);
    if (!parsed) continue;
    if (isWorkContent(parsed.inline)) addStep(recommendations, parsed.inline);
    for (index += 1; index < lines.length; index += 1) {
      if (isSectionHeading(lines[index])) { index -= 1; break; }
      const item = cleanWorkItem(lines[index]);
      if (item && isWorkContent(item)) addStep(recommendations, item);
    }
  }
  return recommendations.slice(0, 50);
}

function parseUnfinishedHeading(line: string): { inline: string } | undefined {
  const trimmed = line.trim();
  const markdownHeading = /^#{1,6}\s+/.test(trimmed);
  const boldHeading = /^(?:\*\*|__).+(?:\*\*|__)$/.test(trimmed);
  const normalized = trimmed.replace(/^#{1,6}\s*/, "").replace(/\*\*|__/g, "").trim();
  const colon = normalized.indexOf(":");
  const label = (colon >= 0 ? normalized.slice(0, colon) : normalized).replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!(markdownHeading || boldHeading || colon >= 0) || !UNFINISHED_LABEL.test(label)) return undefined;
  return { inline: colon >= 0 ? normalized.slice(colon + 1).trim() : "" };
}

function parseRecommendationHeading(line: string): { inline: string } | undefined {
  const trimmed = line.trim();
  const markdownHeading = /^#{1,6}\s+/.test(trimmed);
  const boldHeading = /^(?:\*\*|__).+(?:\*\*|__):?$/.test(trimmed);
  const normalized = trimmed.replace(/^#{1,6}\s*/, "").replace(/\*\*|__/g, "").trim();
  const colon = normalized.indexOf(":");
  const label = (colon >= 0 ? normalized.slice(0, colon) : normalized).trim();
  if (!(markdownHeading || boldHeading || colon >= 0) || !RECOMMENDATION_LABEL.test(label)) return undefined;
  return { inline: colon >= 0 ? normalized.slice(colon + 1).trim() : "" };
}

function isSectionHeading(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed) || /^(?:\*\*|__).+(?:\*\*|__):?$/.test(trimmed);
}

function cleanWorkItem(line: string): string {
  return line.trim().replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, "").replace(/^\d+[.)]\s+/, "").replace(/^[*_`]+|[*_`]+$/g, "").trim();
}

function addStep(steps: string[], value: string): void {
  const step = cleanWorkItem(value);
  if (!step || EMPTY_REMAINDER.test(step) || steps.some(existing => existing.toLocaleLowerCase() === step.toLocaleLowerCase())) return;
  steps.push(step);
}

function isWorkContent(value: string): boolean {
  const normalized = value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`]/g, "")
    .trim();
  return normalized.length > 0 && !EMPTY_REMAINDER.test(normalized);
}
