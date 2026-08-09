import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../../common/errors";

export async function readTaskFiles(args: string[]): Promise<Array<{ sourcePath: string; prompt: string }>> {
  const marker = args.findIndex(arg => arg === "-f" || arg === "--file");
  if (marker < 0) throw new ClineConsoleError("MISSING_FILE", "add requires -f followed by one or more task files.");
  const filenames = args.slice(marker + 1);
  if (!filenames.length || filenames.some(name => name.startsWith("-"))) throw new ClineConsoleError("MISSING_FILE", "add -f requires one or more task files.");
  return Promise.all(filenames.map(async filename => {
    const sourcePath = await fs.realpath(path.resolve(filename));
    const prompt = await fs.readFile(sourcePath, "utf8");
    if (!prompt.length) throw new ClineConsoleError("EMPTY_PROMPT", `Task file is empty: ${sourcePath}`);
    return { sourcePath, prompt };
  }));
}

export async function readTasks(args: string[]): Promise<Array<{ sourcePath: string; prompt: string }>> {
  const directoryMarker = args.findIndex(arg => arg === "-d" || arg === "--directory");
  const fileMarker = args.findIndex(arg => arg === "-f" || arg === "--file");
  if (directoryMarker >= 0 && fileMarker >= 0) throw new ClineConsoleError("AMBIGUOUS_INPUT", "add accepts either -f files or -d directory, not both.");
  if (directoryMarker < 0) return readTaskFiles(args);
  const directoryArgument = args[directoryMarker + 1];
  if (!directoryArgument) throw new ClineConsoleError("MISSING_DIRECTORY", "-d/--directory requires a path.");
  if (args.length !== directoryMarker + 2) throw new ClineConsoleError("INVALID_ARGUMENT", "-d/--directory accepts exactly one directory path.");
  const directory = await fs.realpath(path.resolve(directoryArgument));
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new ClineConsoleError("NOT_A_DIRECTORY", `Not a directory: ${directory}`);
  const files = await discoverRegularFiles(directory);
  if (!files.length) throw new ClineConsoleError("EMPTY_DIRECTORY", `No regular task files found in directory: ${directory}`);
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
