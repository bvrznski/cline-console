import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../../common/errors";

export async function readTaskFiles(args: string[]): Promise<Array<{ sourcePath: string; prompt: string }>> {
  const marker = args.findIndex(arg => arg === "-f" || arg === "--file");
  if (marker < 0) throw new ClineConsoleError("MISSING_FILE", "-f must be followed by one or more task files.");
  const filenames = args.slice(marker + 1);
  if (!filenames.length || filenames.some(name => name.startsWith("-"))) throw new ClineConsoleError("MISSING_FILE", "-f requires one or more task files.");
  return Promise.all(filenames.map(async filename => {
    const sourcePath = await fs.realpath(path.resolve(filename));
    const prompt = await fs.readFile(sourcePath, "utf8");
    if (!prompt.length) throw new ClineConsoleError("EMPTY_PROMPT", `Task file is empty: ${sourcePath}`);
    return { sourcePath, prompt };
  }));
}

export async function readTasks(args: string[]): Promise<Array<{ sourcePath: string; prompt: string }>> {
  const directoryMarker = args.findIndex(arg => arg === "-d" || arg === "--dir" || arg === "--directory");
  const fileMarker = args.findIndex(arg => arg === "-f" || arg === "--file");
  const newerMarker = args.findIndex(arg => arg === "--newer-than");
  if (directoryMarker >= 0 && fileMarker >= 0) throw new ClineConsoleError("AMBIGUOUS_INPUT", "Use either -f files or -d directory, not both.");
  if (newerMarker >= 0 && directoryMarker < 0) throw new ClineConsoleError("INVALID_ARGUMENT", "--newer-than is valid only with --dir.");
  if (directoryMarker < 0) {
    if (fileMarker < 0) {
      if (!args.length || args.some(argument => argument.startsWith("-"))) {
        throw new ClineConsoleError("MISSING_FILE", "queue add requires one or more task file paths, optionally preceded by -f/--file.");
      }
      return readTaskFiles(["-f", ...args]);
    }
    return readTaskFiles(args);
  }
  const directoryArgument = args[directoryMarker + 1];
  if (!directoryArgument) throw new ClineConsoleError("MISSING_DIRECTORY", "-d/--dir requires a path.");
  const expectedLength = newerMarker >= 0 ? 4 : 2;
  if (args.length !== expectedLength) throw new ClineConsoleError("INVALID_ARGUMENT", "Use --dir DIRECTORY with an optional --newer-than REFERENCE_FILE.");
  const referenceArgument = newerMarker >= 0 ? args[newerMarker + 1] : undefined;
  if (newerMarker >= 0 && !referenceArgument) throw new ClineConsoleError("MISSING_FILE", "--newer-than requires a reference file.");
  const directory = await fs.realpath(path.resolve(directoryArgument));
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new ClineConsoleError("NOT_A_DIRECTORY", `Not a directory: ${directory}`);
  let files = await discoverRegularFiles(directory);
  if (referenceArgument) {
    const reference = await fs.realpath(path.resolve(referenceArgument));
    const referenceStat = await fs.stat(reference);
    if (!referenceStat.isFile()) throw new ClineConsoleError("NOT_A_FILE", `Reference is not a regular file: ${reference}`);
    const candidates = await Promise.all(files.map(async file => ({ file, mtimeMs: (await fs.stat(file)).mtimeMs })));
    files = candidates.filter(candidate => candidate.mtimeMs > referenceStat.mtimeMs).map(candidate => candidate.file);
  }
  if (!files.length) throw new ClineConsoleError("EMPTY_DIRECTORY", referenceArgument
    ? `No regular task files newer than the reference file were found in: ${directory}`
    : `No regular task files found in directory: ${directory}`);
  return readTaskFiles(["-f", ...files]);
}

async function discoverRegularFiles(directory: string): Promise<string[]> {
  const discovered: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
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
