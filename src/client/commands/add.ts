import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../../common/errors";
import { analyzeRangeGaps, enforceRangeGapPolicy, formatGapReport, loadPhasePlan, type RangeGapReport, type VersionTuple } from "./phase_plan";

export interface TaskFile { sourcePath: string; prompt: string; }
export interface TaskInput { tasks: TaskFile[]; expandedRange?: string[]; rangeGapReport?: RangeGapReport; }
export const MAX_TASK_BATCH_BYTES = 384 * 1024 * 1024;
export interface ReadTasksOptions {
    strictRange?: boolean;
    warnGaps?: boolean;
    baseDirectory?: string;
    workspaceDirectory?: string;
}

/**
 * Keep task payloads comfortably below the 512 MiB IPC frame limit. The margin
 * covers the request envelope, workspace path, request ID, and flags added by
 * the caller while preserving task order.
 */
export function splitTaskBatches<T extends TaskFile>(tasks: T[], maxBytes = MAX_TASK_BATCH_BYTES): T[][] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ClineConsoleError("INVALID_ARGUMENT", "Task batch byte limit must be a positive integer.");
  const envelopeBytes = Buffer.byteLength('{"tasks":[]}', "utf8");
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = envelopeBytes;
  for (const task of tasks) {
    // Serialize each task once.  Re-serializing the entire growing candidate
    // array made splitting n tasks O(n^2) in both CPU work and allocation.
    const taskBytes = Buffer.byteLength(JSON.stringify(task), "utf8");
    const singleBytes = envelopeBytes + taskBytes;
    if (singleBytes > maxBytes) throw new ClineConsoleError("TASK_TOO_LARGE", `Task file exceeds the safe IPC payload size: ${task.sourcePath}`);
    const candidateBytes = batchBytes + taskBytes + (batch.length ? 1 : 0);
    if (batch.length && candidateBytes > maxBytes) {
      batches.push(batch);
      batch = [task];
      batchBytes = envelopeBytes + taskBytes;
    } else {
      batch.push(task);
      batchBytes = candidateBytes;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function resolveInputPath(filename: string, options: ReadTasksOptions): Promise<string> {
  const local = path.resolve(options.baseDirectory ?? process.cwd(), filename);
  const candidates = [local];
  if (!path.isAbsolute(filename) && options.workspaceDirectory) {
    const workspacePath = path.resolve(options.workspaceDirectory, filename);
    if (workspacePath !== local) candidates.push(workspacePath);
  }
  for (const candidate of candidates) {
    try { return await fs.realpath(candidate); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new ClineConsoleError("INPUT_NOT_FOUND", `Task input not found: ${filename}. Tried: ${candidates.join(", ")}`);
}

export async function readTaskFiles(args: string[], options: ReadTasksOptions = {}): Promise<TaskFile[]> {
  const marker = args.findIndex(arg => arg === "-f" || arg === "--file");
  if (marker < 0) throw new ClineConsoleError("MISSING_FILE", "-f must be followed by one or more task files.");
  const filenames = args.slice(marker + 1);
  if (!filenames.length || filenames.some(name => name.startsWith("-"))) throw new ClineConsoleError("MISSING_FILE", "-f requires one or more task files.");
  const tasks = new Array<TaskFile>(filenames.length);
  // Bound filesystem concurrency so a directory containing thousands of
  // tasks cannot exhaust file descriptors or flood the libuv thread pool.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(32, filenames.length) }, async () => {
    while (cursor < filenames.length) {
      const index = cursor++;
      const sourcePath = await resolveInputPath(filenames[index], options);
      const prompt = await fs.readFile(sourcePath, "utf8");
      if (!prompt.length) throw new ClineConsoleError("EMPTY_PROMPT", `Task file is empty: ${sourcePath}`);
      tasks[index] = { sourcePath, prompt };
    }
  });
  await Promise.all(workers);
  return tasks;
}

export async function readTasks(args: string[], options: ReadTasksOptions = {}): Promise<TaskInput> {
  const directoryMarker = args.findIndex(arg => arg === "-d" || arg === "--dir" || arg === "--directory");
  const fileMarker = args.findIndex(arg => arg === "-f" || arg === "--file");
  const manifestMarker = args.findIndex(arg => arg === "--from");
  const newerMarker = args.findIndex(arg => arg === "--newer-than");
  if (manifestMarker >= 0) {
    if (args.length !== 2 || manifestMarker !== 0 || !args[1]) throw new ClineConsoleError("INVALID_ARGUMENT", "--from requires exactly one manifest file.");
    const manifestPath = await resolveInputPath(args[1], options);
    const manifestStat = await fs.stat(manifestPath);
    if (!manifestStat.isFile()) throw new ClineConsoleError("NOT_A_FILE", `Task manifest is not a regular file: ${manifestPath}`);
    const filenames = (await fs.readFile(manifestPath, "utf8"))
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("#"));
    if (!filenames.length) throw new ClineConsoleError("EMPTY_MANIFEST", `Task manifest contains no task paths: ${manifestPath}`);
    return { tasks: await readTaskFiles(["-f", ...filenames], { ...options, baseDirectory: path.dirname(manifestPath) }) };
  }
  if (directoryMarker >= 0 && fileMarker >= 0) throw new ClineConsoleError("AMBIGUOUS_INPUT", "Use either -f files or -d directory, not both.");
  if (newerMarker >= 0 && directoryMarker < 0) throw new ClineConsoleError("INVALID_ARGUMENT", "--newer-than is valid only with --dir.");
  if (directoryMarker < 0) {
    const positionalFiles = fileMarker < 0 ? args : args.slice(fileMarker + 1);
    const rangeExpansion = await expandNumericTaskRange(positionalFiles, options);
    if (rangeExpansion) {
      return {
        tasks: await readTaskFiles(["-f", ...rangeExpansion.files], options),
        expandedRange: rangeExpansion.files,
        ...(rangeExpansion.gapReport ? { rangeGapReport: rangeExpansion.gapReport } : {})
      };
    }
    if (fileMarker < 0) {
      if (!args.length || args.some(argument => argument.startsWith("-"))) {
        throw new ClineConsoleError("MISSING_FILE", "queue add requires one or more task file paths, optionally preceded by -f/--file.");
      }
      return { tasks: await readTaskFiles(["-f", ...args], options) };
    }
    return { tasks: await readTaskFiles(args, options) };
  }
  const directoryArgument = args[directoryMarker + 1];
  if (!directoryArgument) throw new ClineConsoleError("MISSING_DIRECTORY", "-d/--dir requires a path.");
  const expectedLength = newerMarker >= 0 ? 4 : 2;
  if (args.length !== expectedLength) throw new ClineConsoleError("INVALID_ARGUMENT", "Use --dir DIRECTORY with an optional --newer-than REFERENCE_FILE.");
  const referenceArgument = newerMarker >= 0 ? args[newerMarker + 1] : undefined;
  if (newerMarker >= 0 && !referenceArgument) throw new ClineConsoleError("MISSING_FILE", "--newer-than requires a reference file.");
  const directory = await resolveInputPath(directoryArgument, options);
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new ClineConsoleError("NOT_A_DIRECTORY", `Not a directory: ${directory}`);
  let files = await discoverRegularFiles(directory);
  if (referenceArgument) {
    const reference = await resolveInputPath(referenceArgument, options);
    const referenceStat = await fs.stat(reference);
    if (!referenceStat.isFile()) throw new ClineConsoleError("NOT_A_FILE", `Reference is not a regular file: ${reference}`);
    const candidates = await Promise.all(files.map(async file => ({ file, mtimeMs: (await fs.stat(file)).mtimeMs })));
    files = candidates.filter(candidate => candidate.mtimeMs > referenceStat.mtimeMs).map(candidate => candidate.file);
  }
  if (!files.length) throw new ClineConsoleError("EMPTY_DIRECTORY", referenceArgument
    ? `No regular task files newer than the reference file were found in: ${directory}`
    : `No regular task files found in directory: ${directory}`);
  return { tasks: await readTaskFiles(["-f", ...files]) };
}

export function formatExpandedRangeNotice(paths: string[], gapReport?: RangeGapReport): string {
  const names = paths.map(filePath => path.basename(filePath));
  const countLabel = gapReport?.plannedInRange.length ? `${names.length}/${gapReport.plannedInRange.length} planned` : String(names.length);
  return `Expanded range (${countLabel}): ${names.join(", ")}\n${gapReport && (gapReport.missingRequired.length || gapReport.skippedOptional.length || gapReport.orphans.length) ? formatGapReport(gapReport) : ""}`;
}

async function expandNumericTaskRange(args: string[], options: ReadTasksOptions): Promise<{ files: string[]; gapReport?: RangeGapReport } | undefined> {
  if (args.length !== 3 || args[1] !== "-") return undefined;
  const startBase = options.baseDirectory ? path.resolve(options.baseDirectory) : process.cwd();
  const startPath = path.resolve(startBase, args[0]);
  const startName = path.basename(startPath);
  const endName = path.basename(args[2]);
  if (!/^\d+$/.test(endName)) {
    const startVersion = parseVersionFilename(startName);
    const endVersion = parseVersionFilename(endName);
    if (startVersion && endVersion) return expandVersionTaskRange(startPath, startName, args[2], startVersion, endVersion, options);
  }
  return { files: await expandPrefixedTaskRange(startPath, startName, args[2], endName) };
}

async function expandVersionTaskRange(startPath: string, startName: string, endArg: string, start: ParsedVersionTuple, end: ParsedVersionTuple, options: ReadTasksOptions): Promise<{ files: string[]; gapReport?: RangeGapReport }> {
  if (compareVersion(end, start) < 0) throw new ClineConsoleError("INVALID_ARGUMENT", `Task range end ${endArg} precedes start ${startName}.`);
  const directory = path.dirname(startPath);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const matched = entries
    .filter(entry => entry.isFile())
    .map(entry => ({ name: entry.name, version: parseVersionFilename(entry.name) }))
    .filter((entry): entry is { name: string; version: ParsedVersionTuple } => Boolean(entry.version))
    .map(entry => ({
      path: path.join(directory, entry.name),
      version: entry.version
    }))
    .filter(entry => compareVersion(entry.version, start) >= 0 && compareVersion(entry.version, end) <= 0)
    .sort((left, right) => compareVersion(left.version, right.version) || left.path.localeCompare(right.path, "en"));
  const files = dedupeByKey(matched, entry => `${entry.version.major}.${entry.version.minor}`, entry => entry.path, startName, endArg);
  const plan = await loadPhasePlan(directory);
  if (!plan) return { files };
  const gapReport = analyzeRangeGaps(plan.entries, start, end, files);
  gapReport.planSource = plan.source;
  enforceRangeGapPolicy(gapReport, plan.source, options.strictRange === true);
  if (options.warnGaps === false) {
    gapReport.missingRequired = [];
    gapReport.skippedOptional = [];
    gapReport.orphans = [];
  }
  return { files, gapReport };
}

async function expandPrefixedTaskRange(startPath: string, startName: string, endArg: string, endName: string): Promise<string[]> {
  const match = parseNumberedFilename(startName);
  if (!match) throw new ClineConsoleError("INVALID_ARGUMENT", `Range start must end in an integer, optionally before a filename extension: ${startName}`);
  const { prefix, extension, number: start } = match;
  const end = /^\d+$/.test(endName)
    ? Number(endName)
    : (() => {
        const endMatch = parseNumberedFilename(endName);
        if (!endMatch || endMatch.prefix !== prefix) {
          throw new ClineConsoleError("INVALID_ARGUMENT", `Range end must be an integer or match the start filename prefix: ${endArg}`);
        }
        return endMatch.number;
      })();
  if (end < start) throw new ClineConsoleError("INVALID_ARGUMENT", `Task range end ${end} precedes start ${start}.`);
  const directory = path.dirname(startPath);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const extensionPattern = extension ? escapeRegExp(extension) : "(\\.[A-Za-z_][^.]*)?";
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)${extensionPattern}$`);
  const matched = entries
    .filter(entry => entry.isFile())
    .map(entry => ({ name: entry.name, match: entry.name.match(pattern) }))
    .filter((entry): entry is { name: string; match: RegExpMatchArray } => Boolean(entry.match))
    .map(entry => ({ path: path.join(directory, entry.name), number: Number(entry.match[1]) }))
    .filter(entry => entry.number >= start && entry.number <= end)
    .sort((left, right) => left.number - right.number || left.path.localeCompare(right.path, "en"));
  return dedupeByKey(matched, entry => String(entry.number), entry => entry.path, startName, endArg);
}

function dedupeByKey<T>(matched: T[], keyOf: (entry: T) => string, pathOf: (entry: T) => string, startName: string, endArg: string): string[] {
  const files: string[] = [];
  let previousKey: string | undefined;
  for (const entry of matched) {
    const key = keyOf(entry);
    if (previousKey === key) continue;
    previousKey = key;
    files.push(pathOf(entry));
  }
  if (!files.length) throw new ClineConsoleError("EMPTY_RANGE", `No regular task files found in numeric range ${startName} - ${endArg}.`);
  return files;
}

interface ParsedVersionTuple extends VersionTuple { extension: string; }

function parseVersionFilename(name: string): ParsedVersionTuple | undefined {
  const versionMatch = name.match(/(?:^|[^0-9])(\d+)\.(\d+)(?=$|[^0-9])/);
  return versionMatch ? { major: Number(versionMatch[1]), minor: Number(versionMatch[2]), extension: "" } : undefined;
}

function compareVersion(left: VersionTuple, right: VersionTuple): number {
  return left.major - right.major || left.minor - right.minor;
}

function parseNumberedFilename(name: string): { prefix: string; number: number; extension: string } | undefined {
  const { stem, extension } = splitFilenameExtension(name);
  const numbered = stem.match(/^(.*?)(\d+)$/);
  return numbered ? { prefix: numbered[1], number: Number(numbered[2]), extension } : undefined;
}

function splitFilenameExtension(name: string): { stem: string; extension: string } {
  const extensionMatch = name.match(/(\.[A-Za-z_][^.]*)$/);
  const extension = extensionMatch?.[1] ?? "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  return { stem, extension };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function discoverRegularFiles(directory: string): Promise<string[]> {
  const discovered: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => {
      // Try version-style sorting first (e.g., 0.1.md, 0.2.md, ..., 0.12.md)
      const leftVersion = parseVersionFilename(left.name);
      const rightVersion = parseVersionFilename(right.name);
      if (leftVersion && rightVersion) {
        return compareVersion(leftVersion, rightVersion) || left.name.localeCompare(right.name, "en");
      }
      // Fall back to numbered filename sorting (e.g., task1, task2, ..., task12)
      const leftMatch = parseNumberedFilename(left.name);
      const rightMatch = parseNumberedFilename(right.name);
      if (leftMatch && rightMatch) {
        return leftMatch.number - rightMatch.number || left.name.localeCompare(right.name, "en");
      }
      // Fallback to lexicographic sort for non-numbered files
      return left.name.localeCompare(right.name, "en");
    });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) discovered.push(candidate);
    }
  };
  await visit(directory);
  return discovered;
}
