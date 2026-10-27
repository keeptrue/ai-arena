/** Minimal, dependency-free SSE reader over a fetch body stream. */

import { ProviderError } from "./types";

export async function readSse(
  body: ReadableStream<Uint8Array> | null,
  onEvent: (data: string, event: string | null) => void,
  /**
   * Liveness tap: fires for every chunk of bytes, including `:` keep-alive
   * comments and frames that turn out to carry no content. A gateway that pings
   * while a model thinks must look alive, not silent.
   */
  onBeat?: () => void,
): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | null = null;
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = null;
      return;
    }
    const data = dataLines.join("\n");
    const name = eventName;
    eventName = null;
    dataLines = [];
    onEvent(data, name);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) onBeat?.();
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        flush();
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
        continue;
      }
      // Some gateways emit bare JSON lines.
      dataLines.push(line);
    }
  }
  flush();
}

export async function assertOk(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  const retryable = res.status === 429 || res.status >= 500;
  throw new ProviderError(`${provider} HTTP ${res.status}`, res.status, body.slice(0, 800), retryable);
}
