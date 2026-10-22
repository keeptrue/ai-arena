import { streamEvents } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const after = Number(new URL(req.url).searchParams.get("after") ?? "0");
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      send(`retry: 2000\n\n`);
      const heartbeat = setInterval(() => send(`: ping\n\n`), 15000);

      try {
        for await (const event of streamEvents(id, Number.isFinite(after) ? after : 0, abort.signal)) {
          send(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch {
        /* client vanished */
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
