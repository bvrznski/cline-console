import { execFile } from "node:child_process";

/** Match an interactive sudo invocation while ignoring sudo -n/--non-interactive. */
export function containsInteractiveSudo(commandLine: string): boolean {
  const unquoted = commandLine.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "");
  const commands = unquoted.split(/(?:&&|\|\||;|\n)/);
  return commands.some(command => {
    const match = command.match(/(?:^|[\s/])sudo(?:\s+([^|;&\n]*))?/);
    if (!match) return false;
    const argumentsText = match[1] ?? "";
    return !/(?:^|\s)(?:-n|--non-interactive)(?:\s|$)/.test(argumentsText);
  });
}

export function showSudoZenityPrompt(workspace: string, fallback?: () => void): void {
  const child = execFile("zenity", [
    "--warning",
    "--title=Cline requires sudo authentication",
    `--text=Cline started an interactive sudo command in:\n${workspace}\n\nReturn to the VS Code terminal and enter the password there. The password is not collected by Cline Console.`,
    "--width=480"
  ], error => {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") fallback?.();
  });
  child.unref();
}
