import net from "node:net";
import { ClineConsoleError } from "../common/errors";
import { MAX_MESSAGE_BYTES } from "./protocol";
import type { IpcRequest, IpcResponse } from "./types";

export async function requestOverSocket(socketPath: string, request: IpcRequest, timeoutMs = 15_000): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(new ClineConsoleError("TIMEOUT", "Timed out waiting for the VS Code extension.")), timeoutMs);
    const done = (error?: Error, response?: IpcResponse): void => {
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(response as IpcResponse);
    };
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_MESSAGE_BYTES) return done(new ClineConsoleError("RESPONSE_TOO_LARGE", "IPC response exceeds the size limit."));
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try { done(undefined, JSON.parse(data.subarray(0, newline).toString("utf8")) as IpcResponse); }
      catch { done(new ClineConsoleError("MALFORMED_RESPONSE", "VS Code returned malformed JSON.")); }
    });
    socket.once("error", error => done(error));
    socket.once("end", () => { if (!data.includes(10)) done(new ClineConsoleError("EMPTY_RESPONSE", "VS Code closed the IPC connection without a response.")); });
  });
}
