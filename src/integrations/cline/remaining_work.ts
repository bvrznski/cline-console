import fs from "node:fs";
import path from "node:path";

const UNFINISHED_LABEL = /^(?:what\s+remains\b.*|remaining\b.*|outstanding\b.*|pending\b.*|future work|next steps?|todos?|open (?:items?|work)|deferred (?:items?|work)|unimplemented (?:items?|work|features?)|incomplete (?:items?|work|stages?|implementation))$/i;
const BARE_UNFINISHED_HEADING = /^(?:(?:remaining|outstanding|pending)(?:\s+further)?\s+(?:work|tasks?|items?|stages?|steps?|enhancements?|improvements?|actions?|changes?|features?|implementation)|future work|next steps?|todos?|open (?:items?|work)|deferred (?:items?|work)|unimplemented (?:items?|work|features?)|incomplete (?:items?|work|stages?|implementation))$/i;
const INCOMPLETE_STATUS = /^(?:final |completion )?status\s*:\s*(?:partial(?:ly complete)?|incomplete|blocked|not complete|requires? (?:work|completion))\b/i;
const INCOMPLETE_CERTIFICATION = /\b(?:capability|implementation|migration|task|phase)\s+(?:is\s+)?(?:partial|incomplete|blocked)\s*$/i;
const EMPTY_REMAINDER = /^(?:none|nothing|n\/?a|not applicable|no(?:ne)? remaining(?: work| tasks?| items?| stages?| steps?)?|complete(?:d)?|all (?:done|complete(?:d)?))\.?$/i;
const AUDIT_TASK = /\b(?:audit|auditing|assessment|inspection|compliance review|security review|code review)\b/i;
const RECOMMENDATION_LABEL = /^(?:recommended (?:next )?actions?|recommendations?|remediation(?: recommendations?| actions?)?|proposed (?:improvements?|actions?|remediations?))$/i;
const UNFINISHED_TARGET_LABEL = /^to\s+(?:achieve|complete|finish|reach)\b.+$/i;

// Canonical L1 directory structure patterns for core validation
const CANONICAL_L1_DIRS = /^(architecture|communication|control|execution|lifecycle|platform|resilience|runtime|state)$/i;
const INVALID_L1_DIRS = /^(agency|development)$/i;  // Invalid directories that need migration/removal

export interface CompletionAudit { requiresContinuation: boolean; reason: string; }

export interface CompletionAuditOptions {
  workspacePath?: string;  // Path to validate directory structure against
}

/** A later-phase ledger is documentation, not a request to expand current scope. */
function withoutLaterPhaseLedger(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let start = 0; start < lines.length; start++) {
    const heading = lines[start].match(/^\s*(#{1,6})\s+Deferred Work Ledger\s*:?\s*#*\s*$/i);
    if (!heading) continue;
    let end = start + 1;
    while (end < lines.length) {
      const next = lines[end].match(/^\s*(#{1,6})\s+/);
      if (next && next[1].length <= heading[1].length) break;
      end++;
    }
    const body = lines.slice(start + 1, end).join("\n");
    if (!/^\s*Work intentionally deferred to later phases\b/im.test(body)) continue;
    // Do not suppress an explicit admission that the current scope is unfinished.
    if (/\b(?:current|this)\s+(?:task|phase|scope)\b[^\n]*(?:incomplete|unfinished|blocked|pending|remaining|not complete)/i.test(body)) continue;
    for (let index = start; index < end; index++) lines[index] = "";
    start = end - 1;
  }
  return lines.join("\n");
}

/**
 * Audit completion report for apparent unfinished work including file system validation.
 * Detects cases where completion is claimed but the actual structure doesn't match requirements.
 */
export function auditCompletionReport(text: string | undefined, taskProgressText?: string, options?: CompletionAuditOptions): CompletionAudit {
  if (text) text = withoutLaterPhaseLedger(text);
  const progress = auditTaskProgress(taskProgressText);
  if (progress.requiresContinuation) return progress;
  if (!text?.trim()) return { requiresContinuation: false, reason: "completion report body is missing; no explicit unfinished-work declaration found" };

  // Check for apparent unfinished work based on directory structure
  const structAudit = options?.workspacePath ? auditDirectoryStructure(options.workspacePath) : null;
  if (structAudit?.requiresContinuation) return structAudit;

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
    const bareHeading = colon < 0 && BARE_UNFINISHED_HEADING.test(label);
    const unfinishedTarget = UNFINISHED_TARGET_LABEL.test(label);
    if (!(markdownHeading || boldHeading || colon >= 0 || bareHeading) || (!UNFINISHED_LABEL.test(label) && !unfinishedTarget)) continue;
    const inline = colon >= 0 ? normalized.slice(colon + 1) : "";
    if (isWorkContent(inline)) return { requiresContinuation: true, reason: `unfinished section: ${label}` };
    const content: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (/^\s*#{1,6}\s+/.test(line)) break;
      content.push(line);
    }
    if (isWorkContent(content.join("\n"))) return { requiresContinuation: true, reason: `${unfinishedTarget ? "unachieved target" : "unfinished section"}: ${label}` };
  }

  // Check for apparent completion claims that don't match reality
  const completionClaim = text.toLowerCase();
  if (isCompletionClaimed(text) && hasStructuralIssues(options?.workspacePath)) {
    return { requiresContinuation: true, reason: "apparent completion claimed but directory structure indicates unfinished work" };
  }

  return { requiresContinuation: false, reason: "completion report contains no unfinished-work declarations" };
}

/**
 * Check if the completion report explicitly claims task is complete.
 */
function isCompletionClaimed(text: string): boolean {
  const patterns = [
    /^all\s+(?:work|tasks?|items?)\s+complete(?:d)?/i,
    /^task\s+(?:is|has been)\s+complete(?:d)?/i,
    /^implementation\s+(?:is|has been)\s+complete(?:d)?/i,
    /^(?:no|none|zero)\s+(?:remaining|outstanding|pending)/i,
    /^all (?:checkboxes|stages?|steps?)\s+complete/i
  ];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const pattern of patterns) {
      if (pattern.test(line.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Check if there are structural issues in the workspace.
 */
function hasStructuralIssues(workspacePath?: string): boolean {
  if (!workspacePath || !fs.existsSync(workspacePath)) return false;

  try {
    const coreDir = path.join(workspacePath, "src/agent/components/core");
    if (!fs.existsSync(coreDir)) return false;

    const entries = fs.readdirSync(coreDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Check for invalid directories that should be migrated
      if (INVALID_L1_DIRS.test(entry.name)) return true;
    }
  } catch {
    // Ignore filesystem errors
  }
  return false;
}

/**
 * Audit directory structure for structural issues.
 */
function auditDirectoryStructure(workspacePath: string): CompletionAudit | null {
  try {
    const coreDir = path.join(workspacePath, "src/agent/components/core");
    if (!fs.existsSync(coreDir)) return null;

    const entries = fs.readdirSync(coreDir, { withFileTypes: true });
    const invalidDirs: string[] = [];
    let canonicalCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Check for invalid directories
      if (INVALID_L1_DIRS.test(entry.name)) {
        invalidDirs.push(entry.name);
      }

      // Track which canonical directories exist
      if (CANONICAL_L1_DIRS.test(entry.name)) {
        canonicalCount++;
      }
    }

    // If we have invalid directories, flag it
    if (invalidDirs.length > 0) {
      return { requiresContinuation: true, reason: `invalid directory structure detected: ${invalidDirs.join(", ")} present in core/` };
    }

    // Check for expected canonical structure - at least 6-7 canonical dirs should exist
    const missingCount = 9 - canonicalCount;
    if (missingCount > 2) {
      return { requiresContinuation: true, reason: `incomplete canonical structure: ${canonicalCount}/9 canonical L1 directories present` };
    }

    // Check for agency subdirectory contents that need migration
    const agencyDir = path.join(coreDir, "agency");
    if (fs.existsSync(agencyDir)) {
      try {
        const agencyEntries = fs.readdirSync(agencyDir, { withFileTypes: true });
        if (agencyEntries.length > 0) {
          // Agency directory should be migrated to canonical locations
          return { requiresContinuation: true, reason: `agency/ directory contains ${agencyEntries.length} subdirectories that need migration to canonical locations` };
        }
      } catch {
        // Ignore errors reading agency directory
      }
    }

  } catch {
    // Ignore filesystem errors - assume no structural issues
  }

  return null;
}

export function auditTaskProgress(text: string | undefined): CompletionAudit {
  if (text) text = withoutLaterPhaseLedger(text);
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

export function hasExplicitRemainingWork(text: string | undefined, taskProgressText?: string, options?: CompletionAuditOptions): boolean {
  return auditCompletionReport(text, taskProgressText, options).requiresContinuation;
}

export function extractRemainingSteps(completionText?: string, taskProgressText?: string): string[] {
  if (completionText) completionText = withoutLaterPhaseLedger(completionText);
  if (taskProgressText) taskProgressText = withoutLaterPhaseLedger(taskProgressText);
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
  if (completionText) completionText = withoutLaterPhaseLedger(completionText);
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
  const bareHeading = colon < 0 && BARE_UNFINISHED_HEADING.test(label);
  if (!(markdownHeading || boldHeading || colon >= 0 || bareHeading) || (!UNFINISHED_LABEL.test(label) && !UNFINISHED_TARGET_LABEL.test(label))) return undefined;
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

/**
 * Check if a line is a section heading (markdown or bold)
 */
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
