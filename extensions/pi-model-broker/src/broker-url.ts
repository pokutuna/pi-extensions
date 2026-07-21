import { isIP } from "node:net";

const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function assertProviderName(provider: string): void {
  if (!PROVIDER_NAME.test(provider)) {
    throw new Error(
      `provider name must match ${PROVIDER_NAME.source}: ${JSON.stringify(provider)}`,
    );
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

export function parseBrokerUrl(value: string | undefined): URL {
  if (value === undefined || value === "") {
    throw new Error("PI_MODEL_BROKER_URL is not set");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PI_MODEL_BROKER_URL must be an absolute http(s) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PI_MODEL_BROKER_URL must use http: or https:");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("PI_MODEL_BROKER_URL must not contain userinfo");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("PI_MODEL_BROKER_URL must not contain query or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("PI_MODEL_BROKER_URL pathname must be /");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("http Broker URLs are allowed only on loopback hosts");
  }

  return new URL(url.origin + "/");
}

export function localBasePathForProvider(provider: string, upstreamBaseUrl: string): string {
  assertProviderName(provider);
  const upstream = new URL(upstreamBaseUrl);
  const upstreamPath = upstream.pathname.replace(/\/$/, "");
  return `/providers/${provider}${upstreamPath === "" ? "" : upstreamPath}`;
}

export function assertManifestRouteUrl(baseUrl: string, brokerUrl: URL, provider: string): URL {
  assertProviderName(provider);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`provider "${provider}" baseUrl must be an absolute URL`);
  }

  if (url.origin !== brokerUrl.origin) {
    throw new Error(`provider "${provider}" baseUrl must stay under the broker origin`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`provider "${provider}" baseUrl must not contain userinfo`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`provider "${provider}" baseUrl must not contain query or fragment`);
  }

  const prefix = `/providers/${provider}`;
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw new Error(`provider "${provider}" baseUrl must be under ${prefix}`);
  }
  if (url.pathname.endsWith("/") && url.pathname !== prefix) {
    throw new Error(`provider "${provider}" baseUrl must not end with /`);
  }
  return url;
}

export function canonicalServerUrl(host: string, port: number): string {
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return `http://${displayHost}:${port}/`;
}

export function isLoopbackHost(host: string): boolean {
  return isLoopbackHostname(host);
}
