import net from "node:net";
import http from "node:http";
import type { Logger } from "../common/logging";

export class TaskModelIdentityCache {
  private cached?: { sessionId: string; endpoint: string; value: Promise<string | undefined> };

  get(sessionId: string, host: string, port: number, loader = getLmStudioModelIdentity): Promise<string | undefined> {
    const endpoint = `${host}:${port}`;
    if (this.cached?.sessionId === sessionId && this.cached.endpoint === endpoint) return this.cached.value;
    const value = loader(host, port);
    this.cached = { sessionId, endpoint, value };
    return value;
  }

  clear(): void { this.cached = undefined; }
}

export function probeTcp(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function getLmStudioModelIdentity(host: string, port: number, timeoutMs = 1_000): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    const request = http.get({ host, port, path: "/v1/models", timeout: timeoutMs }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve(undefined); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { if (body.length < 256_000) body += chunk; });
      response.on("end", () => {
        try {
          const value = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
          const ids = [...new Set((value.data ?? []).flatMap(item => typeof item.id === "string" && item.id.trim() ? [item.id.trim()] : []))].sort();
          resolve(ids.length ? `${host}:${port}/${ids.join(",")}` : undefined);
        } catch { resolve(undefined); }
      });
    });
    request.once("timeout", () => { request.destroy(); resolve(undefined); });
    request.once("error", () => resolve(undefined));
  });
}

export async function waitForLmStudio(host: string, port: number, signal: AbortSignal, logger: Logger, pollMs = 2_000): Promise<void> {
  let announced = false;
  while (!signal.aborted) {
    if (await probeTcp(host, port)) {
      if (announced) logger.info(`LM Studio is ready at ${host}:${port}; queue execution may continue.`);
      return;
    }
    if (!announced) {
      logger.info(`Queue waiting for LM Studio at ${host}:${port}.`);
      announced = true;
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, pollMs);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
