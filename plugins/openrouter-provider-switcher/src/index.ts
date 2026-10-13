/**
 * OpenRouter provider switcher for OMP 18.10.x.
 *
 * This intentionally uses only OpenRouterRouting.only/order, the routing
 * fields currently supported by OMP's model schema. Advanced OpenRouter
 * routing fields require separate OMP core changes or request-payload hooks.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";

const STATUS_KEY = "openrouter-upstream";
const API_ROOT = "https://openrouter.ai/api/v1";
const CACHE_TTL_MS = 60_000;
const STALE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_MAX_ENTRIES = 80;
const UPSTREAM_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

interface Percentiles {
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
  p99?: number | null;
}

interface Endpoint {
  name?: string;
  provider_name?: string;
  tag?: string;
  context_length?: number | null;
  max_prompt_tokens?: number | null;
  max_completion_tokens?: number | null;
  quantization?: string | null;
  status?: number | null;
  supported_parameters?: string[];
  supports_implicit_caching?: boolean;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
    request?: string | number | null;
  };
  latency_last_30m?: Percentiles | null;
  throughput_last_30m?: Percentiles | null;
  uptime_last_5m?: number | null;
  uptime_last_30m?: number | null;
  uptime_last_1d?: number | null;
}

interface CacheEntry {
  fetchedAt: number;
  endpoints: Endpoint[];
}

interface Routing {
  only?: string[];
  order?: string[];
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Endpoint[]>>();

function routingOf(model: Model | undefined): Routing | undefined {
  if (model?.provider !== "openrouter") return undefined;
  const compat = model.compat;
  if (!compat || typeof compat !== "object" || !("openRouterRouting" in compat)) return undefined;
  const raw: unknown = compat.openRouterRouting;
  if (!raw || typeof raw !== "object") return undefined;
  const only = "only" in raw && Array.isArray(raw.only)
    ? raw.only.filter((value): value is string => typeof value === "string")
    : undefined;
  const order = "order" in raw && Array.isArray(raw.order)
    ? raw.order.filter((value): value is string => typeof value === "string")
    : undefined;
  return { only, order };
}

function isOpenRouterModel(model: Model | undefined): model is Model {
  return model?.provider === "openrouter";
}

function routingLabel(model: Model): string {
  const routing = routingOf(model);
  if (routing?.only?.length === 1) return `OR→${routing.only[0]}`;
  if (routing?.only?.length) return `OR only(${routing.only.length})`;
  if (routing?.order?.length) return `OR order(${routing.order.length})`;
  return "OR→auto";
}

function routingDescription(model: Model): string {
  const route = routingOf(model);
  if (!route?.only?.length && !route?.order?.length) {
    return "No per-request provider pin (account-level OpenRouter policies may still apply)";
  }
  const parts: string[] = [];
  if (route.only?.length) parts.push(`only: ${route.only.join(", ")}`);
  if (route.order?.length) parts.push(`order: ${route.order.join(" → ")}`);
  return parts.join(" · ");
}

// Agent-specific UI state, not a routing authority. ctx.models.current() is authoritative.
const statusByContext = new Map<string, { text: string | undefined }>();

function statusUpdate(ctx: ExtensionContext, force = false): void {
  if (!ctx.hasUI) return;
  const model = ctx.models.current();
  const next = isOpenRouterModel(model) ? routingLabel(model) : undefined;
  // Only write if changed; the polling fallback shouldn't repaint the footer.
  const entry = statusByContext.get(ctx.agent.id) ?? { text: undefined };
  if (!force && entry.text === next) return;
  entry.text = next;
  statusByContext.set(ctx.agent.id, entry);
  ctx.ui.setStatus(STATUS_KEY, next);
}

function numberOrUndefined(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function costPerMillion(value: unknown): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed === undefined ? undefined : parsed * 1_000_000;
}

function money(value: number | undefined): string {
  if (value === undefined) return "?";
  if (value === 0) return "$0";
  if (value < 0.0001) return `$${value.toPrecision(2)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function endpointDisplay(endpoint: Endpoint, current: string | undefined, duplicate: boolean): string {
  const tag = endpoint.tag!;
  const parts = [`${endpoint.provider_name ?? tag} [${tag}]`];
  const tps = numberOrUndefined(endpoint.throughput_last_30m?.p50);
  const latency = numberOrUndefined(endpoint.latency_last_30m?.p50);
  const uptime = numberOrUndefined(endpoint.uptime_last_30m ?? endpoint.uptime_last_5m);
  if (tps !== undefined) parts.push(`${Math.round(tps)} tok/s p50`);
  if (latency !== undefined) parts.push(`${latency.toFixed(2)}s latency p50`);
  if (uptime !== undefined) parts.push(`${uptime.toFixed(1)}% uptime`);
  if (endpoint.pricing) {
    parts.push(`${money(costPerMillion(endpoint.pricing.prompt))}/${money(costPerMillion(endpoint.pricing.completion))} per 1M input/output tokens`);
  }
  if (endpoint.quantization) parts.push(endpoint.quantization);
  if (endpoint.context_length) parts.push(`${Math.round(endpoint.context_length / 1000)}k ctx`);
  if (endpoint.status !== undefined && endpoint.status !== null && endpoint.status !== 0) {
    parts.push(`status ${endpoint.status}`);
  }
  if (duplicate) parts.push("shared routing slug");
  return `${current === tag ? "● " : "  "}${parts.join(" · ")}`;
}

function getModelIdParts(id: string): { author: string; slug: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash >= id.length - 1) throw new Error(`Invalid OpenRouter model ID: ${id}`);
  return { author: id.slice(0, slash), slug: id.slice(slash + 1) };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function requestForModelId(modelId: string, apiKey: string): Promise<Endpoint[]> {
  const { author, slug } = getModelIdParts(modelId);
  const url = `${API_ROOT}/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status, `OpenRouter endpoints: HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw new Error("Unexpected OpenRouter endpoints payload");
  }
  const data = payload.data;
  if (!data || typeof data !== "object" || !("endpoints" in data) || !Array.isArray(data.endpoints)) {
    throw new Error("OpenRouter did not return an endpoints array");
  }
  return (data.endpoints as Endpoint[]).filter(endpoint =>
    endpoint && typeof endpoint.tag === "string" && UPSTREAM_SLUG.test(endpoint.tag)
  );
}

function routeVariantBaseId(id: string): string | undefined {
  // Never reinterpret :free as a paid model; never strip unknown literal suffixes.
  const match = /^(.*):(nitro|floor|exacto|online)$/i.exec(id);
  if (!match?.[1]) return undefined;
  return match[1];
}

async function loadEndpoints(ctx: ExtensionContext, model: Model, refresh = false): Promise<Endpoint[]> {
  const key = model.id;
  const old = cache.get(key);
  if (!refresh && old && Date.now() - old.fetchedAt < CACHE_TTL_MS) return old.endpoints;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const apiKey = await ctx.modelRegistry.getApiKey(model);
      if (!apiKey) throw new Error("OMP has no OpenRouter API key configured");
      let result: Endpoint[];
      try {
        result = await requestForModelId(model.id, apiKey);
      } catch (error) {
        const base = routeVariantBaseId(model.id);
        if (!(error instanceof HttpError && error.status === 404 && base)) throw error;
        result = await requestForModelId(base, apiKey);
      }
      result = [...result].sort(
        (a, b) =>
          (a.provider_name ?? a.tag ?? "").localeCompare(b.provider_name ?? b.tag ?? "") ||
          (a.tag ?? "").localeCompare(b.tag ?? ""),
      );
      cache.delete(key);
      cache.set(key, { fetchedAt: Date.now(), endpoints: result });
      while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      return result;
    } catch (error) {
      if (!refresh && old && Date.now() - old.fetchedAt < STALE_TTL_MS) {
        ctx.ui.notify("OpenRouter lookup failed; showing cached upstream data", "warning");
        return old.endpoints;
      }
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

function findUniqueEndpoint(endpoints: Endpoint[], query: string): Endpoint | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exactTag = endpoints.find(x => x.tag?.toLowerCase() === q);
  if (exactTag) return exactTag;
  const exact = endpoints.filter(x =>
    x.provider_name?.toLowerCase() === q || x.name?.toLowerCase() === q
  );
  if (new Set(exact.map(x => x.tag)).size === 1) return exact[0];
  const fuzzy = endpoints.filter(x =>
    x.tag?.toLowerCase().includes(q) || x.provider_name?.toLowerCase().includes(q) || x.name?.toLowerCase().includes(q)
  );
  return new Set(fuzzy.map(x => x.tag)).size === 1 ? fuzzy[0] : undefined;
}

type RoutingMode = "pin" | "default" | "auto";

function unpinModel(model: Model): Model {
  // Unlike resolving a bare selector, this overrides a configured only/order
  // for *this session* without mutating models.yml or the registry.
  // Both compat and compatConfig must be cleared: the resolver rebuilds
  // compat from compatConfig, so clearing only one leaves the pin in place.
  return {
    ...model,
    compat: { ...model.compat, openRouterRouting: undefined },
    compatConfig: { ...model.compatConfig, openRouterRouting: undefined },
  } as Model;
}

async function applyRouting(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  mode: RoutingMode,
  upstream?: string,
  expectedId?: string,
): Promise<void> {
  const initial = ctx.models.current();
  if (!isOpenRouterModel(initial)) {
    ctx.ui.notify("Select an OpenRouter model first", "warning");
    return;
  }
  const modelId = expectedId ?? initial.id;
  if (mode === "pin" && (!upstream || !UPSTREAM_SLUG.test(upstream))) {
    ctx.ui.notify("Invalid upstream routing slug", "error");
    return;
  }
  await ctx.waitForIdle();
  const current = ctx.models.current();
  if (!isOpenRouterModel(current) || current.id !== modelId) {
    ctx.ui.notify("Model changed while selecting a provider; nothing was changed", "warning");
    return;
  }

  const base = ctx.models.resolve(`openrouter/${current.id}`);
  if (!isOpenRouterModel(base) || base.id !== current.id) {
    ctx.ui.notify("OMP could not resolve the current model", "error");
    return;
  }
  const target = mode === "default"
    ? base
    : mode === "auto"
      ? unpinModel(base)
      : ctx.models.resolve(`openrouter/${current.id}@${upstream}`);
  if (!isOpenRouterModel(target) || target.id !== current.id) {
    ctx.ui.notify("OMP could not resolve the requested routing", "error");
    return;
  }
  // Switching a model can reapply the catalog's default thinking effort;
  // changing the upstream should not silently change the user's effort dial.
  const priorThinkingLevel = pi.getThinkingLevel();
  try {
    if (!(await pi.setModel(target))) {
      ctx.ui.notify("OMP refused to switch the model; check API credentials", "error");
      return;
    }
    if (priorThinkingLevel !== undefined && pi.getThinkingLevel() !== priorThinkingLevel) {
      pi.setThinkingLevel(priorThinkingLevel);
    }
    const actual = ctx.models.current();
    if (!isOpenRouterModel(actual) || actual.id !== current.id) {
      ctx.ui.notify("OMP reported a switch, but the selected model differs", "error");
      return;
    }
    const observed = routingOf(actual);
    if (mode === "pin" && (observed?.only?.length !== 1 || observed.only[0] !== upstream)) {
      ctx.ui.notify("Model switched, but the requested upstream pin was not retained", "error");
      return;
    }
    if (mode === "auto" && (observed?.only?.length || observed?.order?.length)) {
      ctx.ui.notify("Model switched, but provider routing remains configured", "error");
      return;
    }
    statusUpdate(ctx, true);
    ctx.ui.notify(`${current.id}: ${routingDescription(actual)}`, "info");
  } catch (error) {
    ctx.ui.notify(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function showPicker(pi: ExtensionAPI, ctx: ExtensionCommandContext, refresh = false): Promise<void> {
  const model = ctx.models.current();
  if (!isOpenRouterModel(model)) {
    ctx.ui.notify("Select an OpenRouter model first", "warning");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("The upstream picker requires an interactive UI; pass a provider slug instead", "warning");
    return;
  }
  let endpoints: Endpoint[];
  try {
    endpoints = await loadEndpoints(ctx, model, refresh);
  } catch (error) {
    ctx.ui.notify(`Provider lookup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  const providerTags = endpoints.map(x => x.tag!);
  const counts = new Map<string, number>();
  for (const tag of providerTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const active = routingOf(model)?.only?.length === 1 ? routingOf(model)!.only![0] : undefined;
  const labels = endpoints.map((e, i) => `${endpointDisplay(e, active, (counts.get(e.tag!) ?? 0) > 1)}  #${i + 1}`);
  const AUTO = "Auto — remove only/order for this session";
  const DEFAULT = "Configured default — use models.yml policy";
  const choice = await ctx.ui.select(
    `OpenRouter · ${model.id} · ${routingDescription(model)}`,
    [AUTO, DEFAULT, ...labels],
  );
  if (!choice) return;
  if (choice === DEFAULT) return applyRouting(pi, ctx, "default", undefined, model.id);
  if (choice === AUTO) return applyRouting(pi, ctx, "auto", undefined, model.id);
  const index = labels.indexOf(choice);
  if (index < 0) return;
  return applyRouting(pi, ctx, "pin", endpoints[index].tag, model.id);
}

async function command(pi: ExtensionAPI, raw: string, ctx: ExtensionCommandContext): Promise<void> {
  const arg = raw.trim();
  if (!arg) return showPicker(pi, ctx);
  const model = ctx.models.current();
  switch (arg.toLowerCase()) {
    case "status": {
      const current = ctx.models.current();
      ctx.ui.notify(current?.provider === "openrouter" && isOpenRouterModel(current)
        ? `${current.provider}/${current.id}: ${routingDescription(current)}`
        : current ? `Current model is ${current.provider}/${current.id}` : "No model selected", "info");
      return;
    }
    case "refresh":
      return showPicker(pi, ctx, true);
    case "auto":
    case "reset":
      return applyRouting(pi, ctx, "auto");
    case "default":
      return applyRouting(pi, ctx, "default");
  }
  if (!isOpenRouterModel(model)) {
    ctx.ui.notify("Select an OpenRouter model first", "warning");
    return;
  }
  let endpoints: Endpoint[];
  try {
    endpoints = await loadEndpoints(ctx, model);
  } catch (error) {
    ctx.ui.notify(`Provider lookup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  const match = findUniqueEndpoint(endpoints, arg);
  if (!match?.tag) {
    ctx.ui.notify(`No unique provider matches “${arg}”. Run /or-provider for the full list.`, "warning");
    return;
  }
  return applyRouting(pi, ctx, "pin", match.tag, model.id);
}

export default function openRouterProviderSwitcher(pi: ExtensionAPI): void {
  pi.setLabel("OpenRouter Provider Switcher");
  pi.registerCommand("or-provider", {
    description: "Switch OpenRouter upstream: /or-provider [slug|auto|default|refresh|status]",
    handler: (args, ctx) => command(pi, args, ctx),
  });
  pi.registerCommand("orp", {
    description: "Alias for /or-provider",
    handler: (args, ctx) => command(pi, args, ctx),
  });

  // OMP has no model_select event: poll to catch /model, cycling, and role
  // transitions. One managed timer per agent id, rebound on session_start —
  // a timer from an earlier session closes over a stale context.
  const pollers = new Map<string, unknown>();
  pi.on("session_start", (_event, ctx) => {
    statusUpdate(ctx, true);
    if (!ctx.hasUI) return;
    const old = pollers.get(ctx.agent.id);
    if (old !== undefined) ctx.clearTimer(old as never);
    pollers.set(ctx.agent.id, ctx.setInterval(() => statusUpdate(ctx), 1_000));
  });
  pi.on("session_switch", (_event, ctx) => statusUpdate(ctx, true));
  pi.on("session_tree", (_event, ctx) => statusUpdate(ctx, true));
  pi.on("turn_start", (_event, ctx) => statusUpdate(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    statusByContext.delete(ctx.agent.id);
    const timer = pollers.get(ctx.agent.id);
    if (timer !== undefined) {
      ctx.clearTimer(timer as never);
      pollers.delete(ctx.agent.id);
    }
  });
}
