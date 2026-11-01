/**
 * Same-origin proxy to the API, resolved at request time (API_INTERNAL_URL), so the
 * browser never needs the API host baked into the bundle nor cross-origin CORS.
 * Streams the body through, which keeps the SSE /events stream live.
 */
export const dynamic = "force-dynamic";

const FORWARD_REQUEST = ["accept", "authorization", "content-type", "idempotency-key", "last-event-id", "x-api-key"];
const FORWARD_RESPONSE = ["cache-control", "content-disposition", "content-type", "idempotent-replay", "retry-after"];

const upstream = () => (process.env.API_INTERNAL_URL || "http://localhost:3001").replace(/\/$/, "");

async function proxy(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await params;
  const url = new URL(req.url);
  const target = `${upstream()}/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      signal: req.signal,
      cache: "no-store",
    });
  } catch {
    return Response.json({ message: "API indisponível" }, { status: 502 });
  }
  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const v = res.headers.get(name);
    if (v) out.set(name, v);
  }
  if (out.get("content-type")?.startsWith("text/event-stream")) {
    // No compression or buffering on the way: events must arrive as they are sent.
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST };
