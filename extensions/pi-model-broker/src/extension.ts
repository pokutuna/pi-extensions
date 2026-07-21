import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { parseBrokerUrl } from "./broker-url.ts";
import { BROKER_DUMMY_API_KEY, type ProviderRoute } from "./contract.ts";
import { parseManifest } from "./manifest.ts";

const MANIFEST_PATH = "/v1/providers";
const MANIFEST_TIMEOUT_MS = 3_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function registerProviderRoutes(pi: ExtensionAPI, routes: ProviderRoute[]): void {
  for (const route of routes) {
    pi.registerProvider(route.provider, {
      baseUrl: route.baseUrl,
      apiKey: BROKER_DUMMY_API_KEY,
      ...(route.mode === "custom" ? { api: route.api, models: route.models } : {}),
    });
  }
}

async function readLimitedBody(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length > MAX_MANIFEST_BYTES) {
      throw new Error("broker manifest exceeds the 1 MiB response limit");
    }
  }
  if (response.body === null) throw new Error("broker manifest response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_MANIFEST_BYTES) {
      await reader.cancel();
      throw new Error("broker manifest exceeds the 1 MiB response limit");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("broker manifest is not valid JSON");
  }
}

async function loadManifest(brokerUrl: URL): Promise<ReturnType<typeof parseManifest>> {
  let response: Response;
  try {
    response = await fetch(new URL(MANIFEST_PATH, brokerUrl), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("broker manifest request timed out after 3000 ms");
    }
    throw new Error("broker manifest request failed", { cause: error });
  }
  if (!response.ok) throw new Error(`broker manifest request returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/manifest+json") {
    throw new Error("broker manifest response must have an application/json content type");
  }
  return parseManifest(await readLimitedBody(response), brokerUrl);
}

export default async function providerRoutingExtension(pi: ExtensionAPI): Promise<void> {
  const brokerUrlValue = process.env.PI_MODEL_BROKER_URL;
  if (brokerUrlValue === undefined || brokerUrlValue === "") return;

  const brokerUrl = parseBrokerUrl(brokerUrlValue);
  const manifest = await loadManifest(brokerUrl);
  registerProviderRoutes(pi, manifest.providers);
}
