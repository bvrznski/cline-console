import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../../common/errors";

export type PhaseStatus = "required" | "optional" | "deferred" | "merged_into";

export interface PhasePlanEntry {
  id: string;
  major: number;
  minor: number;
  status: PhaseStatus;
  mergedInto?: string;
}

export interface RangeGapReport {
  planSource: "manifest" | "roadmap";
  plannedInRange: string[];
  queued: string[];
  missingRequired: string[];
  skippedOptional: string[];
  orphans: string[];
}

export interface VersionTuple { major: number; minor: number; }

export function parsePhaseId(id: string): VersionTuple | undefined {
  const match = id.match(/^(\d+)\.(\d+)$/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

export function compareVersion(left: VersionTuple, right: VersionTuple): number {
  return left.major - right.major || left.minor - right.minor;
}

export function versionInRange(version: VersionTuple, start: VersionTuple, end: VersionTuple): boolean {
  return compareVersion(version, start) >= 0 && compareVersion(version, end) <= 0;
}

export function phaseIdFromPath(filePath: string): string | undefined {
  const { stem } = splitFilenameExtension(path.basename(filePath));
  return parsePhaseId(stem) ? stem : undefined;
}

export function parseRoadmapTable(content: string): PhasePlanEntry[] {
  const entries: PhasePlanEntry[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\|\s*\*{0,2}(\d+\.\d+)\*{0,2}\s*\|/);
    if (!match || seen.has(match[1])) continue;
    const parsed = parsePhaseId(match[1]);
    if (!parsed) continue;
    seen.add(match[1]);
    entries.push({ id: match[1], ...parsed, status: "required" });
  }
  entries.sort((left, right) => compareVersion(left, right));
  return entries;
}

export function parseManifestOverrides(content: string): Map<string, Omit<PhasePlanEntry, "id" | "major" | "minor">> {
  const overrides = new Map<string, Omit<PhasePlanEntry, "id" | "major" | "minor">>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const merged = line.match(/^(\d+\.\d+)\s+merged_into=(\d+\.\d+)$/);
    if (merged) {
      overrides.set(merged[1], { status: "merged_into", mergedInto: merged[2] });
      continue;
    }
    const status = line.match(/^(\d+\.\d+)\s+(required|optional|deferred)$/);
    if (status) overrides.set(status[1], { status: status[2] as PhaseStatus });
  }
  return overrides;
}

export async function loadPhasePlan(directory: string): Promise<{ entries: PhasePlanEntry[]; source: "manifest" | "roadmap" } | undefined> {
  const roadmapPath = path.join(directory, "roadmap");
  let roadmapContent: string | undefined;
  try {
    roadmapContent = await fs.readFile(roadmapPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!roadmapContent?.trim()) return undefined;
  const entries = parseRoadmapTable(roadmapContent);
  if (!entries.length) return undefined;
  let source: "manifest" | "roadmap" = "roadmap";
  for (const manifestName of ["manifest", "manifest.json"]) {
    const manifestPath = path.join(directory, manifestName);
    try {
      const manifestContent = await fs.readFile(manifestPath, "utf8");
      if (manifestName.endsWith(".json")) applyManifestJson(entries, manifestContent);
      else applyManifestOverrides(entries, parseManifestOverrides(manifestContent));
      source = "manifest";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { entries, source };
}

function applyManifestOverrides(entries: PhasePlanEntry[], overrides: Map<string, Omit<PhasePlanEntry, "id" | "major" | "minor">>): void {
  for (const entry of entries) {
    const override = overrides.get(entry.id);
    if (!override) continue;
    entry.status = override.status;
    entry.mergedInto = override.mergedInto;
  }
}

function applyManifestJson(entries: PhasePlanEntry[], content: string): void {
  const parsed = JSON.parse(content) as Record<string, string | { status?: string; mergedInto?: string; into?: string }>;
  const overrides = new Map<string, Omit<PhasePlanEntry, "id" | "major" | "minor">>();
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      if (value === "required" || value === "optional" || value === "deferred") overrides.set(id, { status: value });
      continue;
    }
    const status = value.status ?? "required";
    if (status === "merged_into") overrides.set(id, { status: "merged_into", mergedInto: value.mergedInto ?? value.into });
    else if (status === "required" || status === "optional" || status === "deferred") overrides.set(id, { status });
  }
  applyManifestOverrides(entries, overrides);
}

export function analyzeRangeGaps(plan: PhasePlanEntry[], start: VersionTuple, end: VersionTuple, queuedPaths: string[]): RangeGapReport {
  const plannedInRange = plan.filter(entry => versionInRange(entry, start, end)).map(entry => entry.id);
  const plannedSet = new Set(plannedInRange);
  const queued = queuedPaths.map(phaseIdFromPath).filter((id): id is string => Boolean(id));
  const queuedSet = new Set(queued);
  const missingRequired: string[] = [];
  const skippedOptional: string[] = [];
  for (const entry of plan) {
    if (!versionInRange(entry, start, end) || queuedSet.has(entry.id)) continue;
    if (entry.status === "optional" || entry.status === "deferred" || entry.status === "merged_into") skippedOptional.push(entry.id);
    else missingRequired.push(entry.id);
  }
  const orphans = queued.filter(id => !plannedSet.has(id));
  return { planSource: "roadmap", plannedInRange, queued, missingRequired, skippedOptional, orphans };
}

export function enforceRangeGapPolicy(report: RangeGapReport, source: "manifest" | "roadmap", strictRange: boolean): void {
  report.planSource = source;
  if (strictRange && report.missingRequired.length) {
    throw new ClineConsoleError("MISSING_REQUIRED_PHASES", `Range is missing required phase files: ${report.missingRequired.join(", ")} (${source}).`);
  }
}

export function formatGapReport(report: RangeGapReport): string {
  const lines: string[] = [];
  if (report.missingRequired.length) lines.push(`Missing required phases (${report.planSource}): ${report.missingRequired.join(", ")}`);
  if (report.skippedOptional.length) lines.push(`Skipped optional/deferred/merged phases: ${report.skippedOptional.join(", ")}`);
  if (report.orphans.length) lines.push(`Queued but not listed in ${report.planSource}: ${report.orphans.join(", ")}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function splitFilenameExtension(name: string): { stem: string; extension: string } {
  const extensionMatch = name.match(/(\.[A-Za-z_][^.]*)$/);
  const extension = extensionMatch?.[1] ?? "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  return { stem, extension };
}
