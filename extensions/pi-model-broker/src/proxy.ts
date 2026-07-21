import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

const STATIC_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  ...STATIC_HOP_BY_HOP_HEADERS,
  "host",
  "authorization",
  "x-api-key",
  "api-key",
  "content-length",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  ...STATIC_HOP_BY_HOP_HEADERS,
  // undici may transparently decompress an upstream response. Let Node choose
  // the correct framing for the body we actually send downstream.
  "content-encoding",
  "content-length",
]);

export interface ProxyRoute {
  localBasePath: string;
  upstreamBaseUrl: URL;
  headers: Record<string, string>;
}

function connectionHeaderTokens(headers: IncomingMessage["headers"]): Set<string> {
  const value = headers.connection;
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return new Set(
    values
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ""),
  );
}

function requestHeaders(req: IncomingMessage, route: ProxyRoute): Headers {
  const excluded = new Set([...STRIPPED_REQUEST_HEADERS, ...connectionHeaderTokens(req.headers)]);
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (excluded.has(lowerName) || rawValue === undefined) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    headers.set(name, values.join(", "));
  }
  for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);
  return headers;
}

function responseHeaders(response: Response): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [name, value] of response.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) result.push([name, value]);
  }
  return result;
}

export function targetUrl(route: ProxyRoute, incomingPath: string, search: string): URL {
  if (incomingPath !== route.localBasePath && !incomingPath.startsWith(`${route.localBasePath}/`)) {
    throw new Error(`request path is outside provider route ${route.localBasePath}`);
  }
  const suffix = incomingPath.slice(route.localBasePath.length);
  const target = new URL(route.upstreamBaseUrl.toString());
  const upstreamPath = target.pathname.replace(/\/$/, "");
  target.pathname = `${upstreamPath}${suffix === "" ? "" : suffix}` || "/";
  target.search = search;
  return target;
}

function noBodyRequest(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: ProxyRoute,
): Promise<void> {
  const incoming = new URL(req.url ?? "/", "http://broker.invalid");
  const target = targetUrl(route, incoming.pathname, incoming.search);
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers: requestHeaders(req, route),
      redirect: "manual",
      signal: controller.signal,
    };
    if (!noBodyRequest(req.method ?? "GET")) {
      init.body = req as unknown as BodyInit;
      init.duplex = "half";
    }
    const upstream = await fetch(target, init);
    res.statusCode = upstream.status;
    for (const [name, value] of responseHeaders(upstream)) res.setHeader(name, value);
    if (noBodyRequest(req.method ?? "GET") || upstream.body === null) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    body.on("error", (error) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("upstream response stream failed\n");
      } else {
        res.destroy(error as Error);
      }
    });
    body.pipe(res);
  } catch {
    if (controller.signal.aborted || res.destroyed) return;
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Model Broker upstream request failed\n");
    }
  } finally {
    req.off("aborted", abort);
  }
}
