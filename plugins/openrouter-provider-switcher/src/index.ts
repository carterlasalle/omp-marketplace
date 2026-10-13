import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";

const STATUS_KEY = "openrouter-upstream";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CACHE_TTL_MS = 60_000;

interface MetricPercentiles {
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
  p99?: number | null;
}

interface OpenRouterEndpoint {
  name?: string;
  provider_name?: string;
  tag?: string;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  quantization?: string | null;
  status?: number | null;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
    request?: string | number | null;
  };
  latency_last_30m?: MetricPercentiles | null;
  throughput_last_30m?: MetricPercentiles | null;
  uptime_last_5m?: number | null;
  uptime_last_30m?: number | null;
  uptime_last_1d?: number | null;
}

interface OpenRouterEndpointsResponse {
  data?: {
    id?: string;
    name?: string;
    endpoints?: OpenRouterEndpoint[];
  };
}

interface CachedEndpoints {
  fetchedAt: number;
  endpoints: OpenRouterEndpoint[];
}

interface RoutedCompat {
  openRouterRouting?: {
    only?: string[];
    order?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const endpointCache = new Map<string, CachedEndpoints>();

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getOpenRouterUpstream(model: Model | undefined): string | undefined {
  if (!model || model.provider !== "openrouter") return undefined;

  const compat = model.compat as RoutedCompat | undefined;
  const only = compat?.openRouterRouting?.only;

  if (!Array.isArray(only) || only.length !== 1) return undefined;
  const value = only[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function updateStatus(ctx: ExtensionContext, model: Model | undefined): void {
  if (!ctx.hasUI || model?.provider !== "openrouter") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const upstream = getOpenRouterUpstream(model);
  ctx.ui.setStatus(STATUS_KEY, `OR→${upstream ?? "auto"}`);
}

function splitModelId(modelId: string): { author: string; slug: string } | undefined {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return undefined;

  return {
    author: modelId.slice(0, slash),
    slug: modelId.slice(slash + 1),
  };
}

function fallbackBaseModelId(modelId: string): string | undefined {
  const match = modelId.match(/^(.*):(nitro|floor|exacto|online|free)$/i);
  return match?.[1];
}

async function resolveOpenRouterApiKey(
  ctx: ExtensionContext,
  model: Model,
): Promise<string | undefined> {
  const key = await ctx.modelRegistry.getApiKey(model);
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

async function requestEndpoints(
  modelId: string,
  apiKey: string,
): Promise<OpenRouterEndpoint[]> {
  const parsed = splitModelId(modelId);
  if (!parsed) {
    throw new Error(`OpenRouter model id is not in author/model form: ${modelId}`);
  }

  const url = `${OPENROUTER_BASE_URL}/models/${encodeURIComponent(parsed.author)}/${encodeURIComponent(parsed.slug)}/endpoints`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `OpenRouter endpoint lookup failed (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as OpenRouterEndpointsResponse;
  return Array.isArray(payload.data?.endpoints) ? payload.data.endpoints : [];
}

async function getEndpoints(
  ctx: ExtensionContext,
  model: Model,
  forceRefresh = false,
): Promise<OpenRouterEndpoint[]> {
  const now = Date.now();
  const cached = endpointCache.get(model.id);

  if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.endpoints;
  }

  const apiKey = await resolveOpenRouterApiKey(ctx, model);
  if (!apiKey) {
    throw new Error("No OpenRouter API key is available to OMP.");
  }

  let endpoints: OpenRouterEndpoint[];
  try {
    endpoints = await requestEndpoints(model.id, apiKey);
  } catch (error) {
    const fallbackId = fallbackBaseModelId(model.id);
    if (!fallbackId) throw error;
    endpoints = await requestEndpoints(fallbackId, apiKey);
  }

  const deduped = new Map<string, OpenRouterEndpoint>();
  for (const endpoint of endpoints) {
    const tag = endpoint.tag?.trim();
    if (!tag) continue;

    const existing = deduped.get(tag);
    if (!existing) {
      deduped.set(tag, endpoint);
      continue;
    }

    const existingUptime = existing.uptime_last_30m ?? existing.uptime_last_5m ?? -1;
    const candidateUptime = endpoint.uptime_last_30m ?? endpoint.uptime_last_5m ?? -1;
    const existingThroughput = existing.throughput_last_30m?.p50 ?? -1;
    const candidateThroughput = endpoint.throughput_last_30m?.p50 ?? -1;

    if (
      candidateUptime > existingUptime ||
      (candidateUptime === existingUptime && candidateThroughput > existingThroughput)
    ) {
      deduped.set(tag, endpoint);
    }
  }

  const result = [...deduped.values()].sort((a, b) => {
    const an = a.provider_name ?? a.tag ?? "";
    const bn = b.provider_name ?? b.tag ?? "";
    return an.localeCompare(bn);
  });

  endpointCache.set(model.id, { fetchedAt: now, endpoints: result });
  return result;
}

function dollarsPerMillion(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return numeric * 1_000_000;
}

function formatMoney(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatEndpoint(endpoint: OpenRouterEndpoint, current?: string): string {
  const tag = endpoint.tag ?? "unknown";
  const name = endpoint.provider_name ?? tag;
  const details: string[] = [];

  const throughput = endpoint.throughput_last_30m?.p50;
  if (typeof throughput === "number" && Number.isFinite(throughput)) {
    details.push(`${throughput.toFixed(0)} tok/s`);
  }

  const latency = endpoint.latency_last_30m?.p50;
  if (typeof latency === "number" && Number.isFinite(latency)) {
    details.push(`${latency.toFixed(2)}s`);
  }

  const uptime = endpoint.uptime_last_30m ?? endpoint.uptime_last_5m;
  if (typeof uptime === "number" && Number.isFinite(uptime)) {
    details.push(`${uptime.toFixed(1)}% up`);
  }

  const prompt = formatMoney(dollarsPerMillion(endpoint.pricing?.prompt));
  const completion = formatMoney(dollarsPerMillion(endpoint.pricing?.completion));
  if (prompt !== undefined || completion !== undefined) {
    details.push(`${prompt ?? "?"}/${completion ?? "?"} M`);
  }

  if (endpoint.quantization) details.push(endpoint.quantization);

  const selected = current === tag ? "● " : "  ";
  const suffix = details.length > 0 ? ` · ${details.join(" · ")}` : "";
  return `${selected}${name} [${tag}]${suffix}`;
}

function findEndpoint(
  endpoints: OpenRouterEndpoint[],
  query: string,
): OpenRouterEndpoint | undefined {
  const q = normalize(query);
  if (!q) return undefined;

  const exact = endpoints.find(
    endpoint =>
      normalize(endpoint.tag ?? "") === q ||
      normalize(endpoint.provider_name ?? "") === q ||
      normalize(endpoint.name ?? "") === q,
  );
  if (exact) return exact;

  const partial = endpoints.filter(endpoint => {
    const candidates = [endpoint.tag, endpoint.provider_name, endpoint.name]
      .filter((value): value is string => typeof value === "string")
      .map(normalize);
    return candidates.some(value => value.includes(q) || q.includes(value));
  });

  return partial.length === 1 ? partial[0] : undefined;
}

async function setUpstream(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  upstream: string | undefined,
): Promise<void> {
  const current = ctx.models.current();
  if (!current) {
    ctx.ui.notify("No model is currently selected.", "error");
    return;
  }

  if (current.provider !== "openrouter") {
    ctx.ui.notify(
      `Current model is ${current.provider}/${current.id}; switch to an OpenRouter model first.`,
      "warning",
    );
    return;
  }

  const selector = upstream
    ? `openrouter/${current.id}@${upstream}`
    : `openrouter/${current.id}`;

  const next = ctx.models.resolve(selector);
  if (!next) {
    ctx.ui.notify(`OMP could not resolve ${selector}.`, "error");
    return;
  }

  await ctx.waitForIdle();
  const switched = await pi.setModel(next);
  if (!switched) {
    ctx.ui.notify(`Could not switch to ${selector}.`, "error");
    return;
  }

  updateStatus(ctx, next);
  ctx.ui.notify(
    upstream
      ? `${current.id} pinned to OpenRouter → ${upstream}`
      : `${current.id} returned to OpenRouter automatic routing`,
    "info",
  );
}

async function showPicker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  forceRefresh = false,
): Promise<void> {
  const current = ctx.models.current();
  if (!current) {
    ctx.ui.notify("No model is currently selected.", "error");
    return;
  }

  if (current.provider !== "openrouter") {
    ctx.ui.notify(
      `Current model is ${current.provider}/${current.id}; /or-provider only applies to OpenRouter models.`,
      "warning",
    );
    return;
  }

  let endpoints: OpenRouterEndpoint[];
  try {
    endpoints = await getEndpoints(ctx, current, forceRefresh);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
    return;
  }

  if (endpoints.length === 0) {
    ctx.ui.notify(`OpenRouter returned no upstreams for ${current.id}.`, "warning");
    return;
  }

  const currentUpstream = getOpenRouterUpstream(current);
  const autoLabel = `${currentUpstream ? "  " : "● "}Auto — OpenRouter chooses the provider`;
  const rows = endpoints.map(endpoint => ({
    endpoint,
    label: formatEndpoint(endpoint, currentUpstream),
  }));

  const choice = await ctx.ui.select(
    `OpenRouter upstream · ${current.id}`,
    [autoLabel, ...rows.map(row => row.label)],
  );

  if (!choice) return;
  if (choice === autoLabel) {
    await setUpstream(pi, ctx, undefined);
    return;
  }

  const selected = rows.find(row => row.label === choice)?.endpoint;
  if (!selected?.tag) return;
  await setUpstream(pi, ctx, selected.tag);
}

async function handleCommand(
  pi: ExtensionAPI,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const arg = rawArgs.trim();
  const current = ctx.models.current();

  if (!arg) {
    await showPicker(pi, ctx);
    return;
  }

  const normalized = normalize(arg);
  if (normalized === "auto" || normalized === "default" || normalized === "reset") {
    await setUpstream(pi, ctx, undefined);
    return;
  }

  if (normalized === "status") {
    if (!current) {
      ctx.ui.notify("No model is currently selected.", "error");
      return;
    }
    if (current.provider !== "openrouter") {
      ctx.ui.notify(`Current model: ${current.provider}/${current.id}`, "info");
      return;
    }

    ctx.ui.notify(
      `${current.provider}/${current.id} · upstream: ${getOpenRouterUpstream(current) ?? "auto"}`,
      "info",
    );
    return;
  }

  if (normalized === "refresh") {
    if (current) endpointCache.delete(current.id);
    await showPicker(pi, ctx, true);
    return;
  }

  if (!current || current.provider !== "openrouter") {
    ctx.ui.notify("Select an OpenRouter model before choosing an upstream provider.", "warning");
    return;
  }

  let endpoints: OpenRouterEndpoint[];
  try {
    endpoints = await getEndpoints(ctx, current);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
    return;
  }

  const match = findEndpoint(endpoints, arg);
  if (!match?.tag) {
    ctx.ui.notify(
      `No unique OpenRouter upstream matches “${arg}”. Run /or-provider to pick from the live list.`,
      "warning",
    );
    return;
  }

  await setUpstream(pi, ctx, match.tag);
}

export default function openRouterProviderSwitcher(pi: ExtensionAPI): void {
  pi.setLabel("OpenRouter Provider Switcher");

  const command = {
    description: "Choose the upstream provider for the current OpenRouter model",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleCommand(pi, args, ctx);
    },
  };

  pi.registerCommand("or-provider", command);
  pi.registerCommand("orp", {
    ...command,
    description: "Alias for /or-provider",
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx, ctx.models.current());
  });

  pi.on("model_select", async (event, ctx) => {
    updateStatus(ctx, event.model);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
