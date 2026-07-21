import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  assertProviderName,
  canonicalServerUrl,
  isLoopbackHost,
  localBasePathForProvider,
} from "./broker-url.ts";
import type {
  CustomProviderRoute,
  ModelBrokerProviderConfig,
  OverrideProviderRoute,
  ProvidersManifest,
} from "./contract.ts";
import { createManifest } from "./manifest.ts";
import { proxyRequest, type ProxyRoute } from "./proxy.ts";

const FORBIDDEN_CONFIG_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type PreparedManifestRoute = {
  localBasePath: string;
  route: Omit<OverrideProviderRoute, "baseUrl"> | Omit<CustomProviderRoute, "baseUrl">;
};

export interface StartModelBrokerOptions {
  listen: {
    host: string;
    port: number;
  };
  providers: Record<string, ModelBrokerProviderConfig>;
  /** Only for local tests/development. Production upstreams must use HTTPS. */
  allowInsecureHttp?: boolean;
}

export interface ModelBroker {
  readonly url: string;
  readonly manifest: ProvidersManifest;
  close(): Promise<void>;
}

function validateUpstreamUrl(provider: string, value: string, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`provider "${provider}" upstreamBaseUrl must be an absolute URL`);
  }
  if (url.protocol !== "https:") {
    if (!allowInsecureHttp || url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
      throw new Error(`provider "${provider}" upstreamBaseUrl must use HTTPS`);
    }
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`provider "${provider}" upstreamBaseUrl must not contain userinfo`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`provider "${provider}" upstreamBaseUrl must not contain query or fragment`);
  }
  if (url.pathname.endsWith("/") && url.pathname !== "/") url.pathname = url.pathname.slice(0, -1);
  return url;
}

function validateProviderHeaders(provider: string, headers: Record<string, string>): void {
  const normalized = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (normalized.has(lowerName))
      throw new Error(`provider "${provider}" has duplicate header "${name}"`);
    normalized.add(lowerName);
    if (FORBIDDEN_CONFIG_HEADERS.has(lowerName)) {
      throw new Error(`provider "${provider}" cannot configure header "${name}"`);
    }
    if (value === "") throw new Error(`provider "${provider}" header "${name}" must not be empty`);
  }
}

function prepareRoutes(options: StartModelBrokerOptions): {
  routes: ProxyRoute[];
  manifestRoutes: PreparedManifestRoute[];
} {
  const routeEntries = Object.entries(options.providers);
  if (routeEntries.length === 0) throw new Error("Model Broker requires at least one provider");
  const routes: ProxyRoute[] = [];
  const manifestRoutes: PreparedManifestRoute[] = [];
  for (const [provider, config] of routeEntries) {
    assertProviderName(provider);
    const upstreamBaseUrl = validateUpstreamUrl(
      provider,
      config.upstreamBaseUrl,
      options.allowInsecureHttp ?? false,
    );
    validateProviderHeaders(provider, config.headers);
    const localBasePath = localBasePathForProvider(provider, upstreamBaseUrl.toString());
    routes.push({
      localBasePath,
      upstreamBaseUrl,
      headers: { ...config.headers },
    });
    const route =
      config.registration === undefined
        ? { mode: "override" as const, provider }
        : {
            mode: "custom" as const,
            provider,
            api: config.registration.api,
            models: config.registration.models,
          };
    manifestRoutes.push({ localBasePath, route });
  }
  routes.sort((left, right) => right.localBasePath.length - left.localBasePath.length);
  return { routes, manifestRoutes };
}

function findRoute(routes: ProxyRoute[], path: string): ProxyRoute | undefined {
  return routes.find(
    (route) => path === route.localBasePath || path.startsWith(`${route.localBasePath}/`),
  );
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function requestPath(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://broker.invalid");
}

export async function startModelBroker(options: StartModelBrokerOptions): Promise<ModelBroker> {
  const { host, port } = options.listen;
  if (!isLoopbackHost(host)) throw new Error("Model Broker must listen on a loopback host");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("listen.port must be an integer from 0 to 65535");

  const { routes, manifestRoutes } = prepareRoutes(options);
  let brokerManifest: ProvidersManifest | undefined;
  const server = createServer((req, res) => {
    const url = requestPath(req);
    if (req.method === "GET" && url.pathname === "/v1/providers") {
      if (brokerManifest === undefined) {
        writeJson(res, 503, { error: "manifest is not ready" });
      } else {
        writeJson(res, 200, brokerManifest);
      }
      return;
    }
    const route = findRoute(routes, url.pathname);
    if (route === undefined) {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    void proxyRequest(req, res, route);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Model Broker did not expose a TCP address");
  }
  const url = canonicalServerUrl(host, address.port);
  try {
    brokerManifest = createManifest(
      url,
      manifestRoutes.map((route) => ({
        ...route.route,
        baseUrl: new URL(route.localBasePath, url).toString().replace(/\/$/, ""),
      })),
    );
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  let closed = false;
  return {
    url,
    manifest: brokerManifest,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
