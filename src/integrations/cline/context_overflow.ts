const CONTEXT_OVERFLOW = /(?:context_length_exceeded|maximum context (?:length|window)|context window (?:has been )?(?:exceeded|overflowed|is full)|(?:exceeded|overflowed) (?:the )?context window|too many tokens|token limit (?:has been )?exceeded|(?:input|prompt)(?: is)? too long)/i;
const ERROR_KIND = /(?:error|failed|failure|mistake)/i;

export interface ContextOverflowSignal { marker: string; }

export function findLatestContextOverflow(messages: Array<Record<string, unknown>>, sessionId: string): ContextOverflowSignal | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const kind = `${String(message.type ?? "")} ${String(message.ask ?? "")} ${String(message.say ?? "")}`;
    if (!ERROR_KIND.test(kind)) continue;
    const body = typeof message.text === "string" ? message.text : JSON.stringify(message);
    if (!CONTEXT_OVERFLOW.test(body)) continue;
    return { marker: `${sessionId}:${String(message.ts ?? index)}` };
  }
  return undefined;
}
