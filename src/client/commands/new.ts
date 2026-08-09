import { promises as fs } from "node:fs";
import { ClineConsoleError } from "../../common/errors";

export async function readInput(args: string[], stdin: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const fileIndex = args.findIndex(arg => arg === "-f" || arg === "--file");
  if (fileIndex >= 0) {
    const filename = args[fileIndex + 1];
    if (!filename) throw new ClineConsoleError("MISSING_FILE", "-f/--file requires a path.");
    return fs.readFile(filename, "utf8");
  }
  const positional = args.filter((_, index) => index === 0 || (args[index - 1] !== "-f" && args[index - 1] !== "--file"));
  if (positional.length === 1 && positional[0] === "-") return readStdin(stdin);
  if (!positional.length) throw new ClineConsoleError("MISSING_TEXT", "Provide prompt text, -f FILE, or - for stdin.");
  return positional.join(" ");
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}
