export const MANIFEST_VERSION = 1 as const;
export const BROKER_DUMMY_API_KEY = "pi-model-broker-placeholder";

export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type SupportedApi = (typeof SUPPORTED_APIS)[number];

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCompat {
  [key: string]: unknown;
}

export interface ModelMetadata {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  api?: SupportedApi;
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
  >;
  compat?: ModelCompat;
}

export interface OverrideProviderRoute {
  mode: "override";
  provider: string;
  baseUrl: string;
}

export interface CustomProviderRoute {
  mode: "custom";
  provider: string;
  baseUrl: string;
  api: SupportedApi;
  models: ModelMetadata[];
}

export type ProviderRoute = OverrideProviderRoute | CustomProviderRoute;

export interface ProvidersManifest {
  version: typeof MANIFEST_VERSION;
  providers: ProviderRoute[];
}

export interface CustomProviderRegistration {
  api: SupportedApi;
  models: ModelMetadata[];
}

export interface ModelBrokerProviderConfig {
  upstreamBaseUrl: string;
  headers: Record<string, string>;
  registration?: CustomProviderRegistration;
}
