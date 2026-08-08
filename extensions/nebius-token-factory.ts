import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "nebius-token-factory";
const PROVIDER_DISPLAY_NAME = "Nebius Token Factory";
const BASE_URL = "https://api.tokenfactory.nebius.com/v1";
const API_KEY_ENV_VAR = "NEBIUS_TOKEN_FACTORY_API_KEY";
const API_KEY_ENV_REF = `$${API_KEY_ENV_VAR}`;
const DEFAULT_CONTEXT_WINDOW = 131072;
const MAX_OUTPUT_TOKENS = 32768;

// The Token Factory API is frequently flaky (timeouts, 5xx, rate limits), so
// catalog fetches get a per-attempt timeout and retry transient failures.
const FETCH_TIMEOUT_MS = 8_000; // per attempt
const MAX_FETCH_ATTEMPTS = 3; // initial attempt + 2 retries
const FETCH_RETRY_BACKOFF_MS = [250, 1_000]; // delay before retries 1 and 2
// The startup pre-fetch blocks extension load, so it uses a tighter budget.
const PREFETCH_TIMEOUT_MS = 5_000;
const PREFETCH_MAX_ATTEMPTS = 2;

interface NebiusTokenFactoryModel {
	id: string;
	name?: string;
	context_length?: number;
	supported_features?: string[];
	architecture?: { modality?: string };
	pricing?: {
		prompt?: string;
		completion?: string;
	};
}

type RegisteredModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: { supportsDeveloperRole: boolean; maxTokensField: "max_tokens" };
};

// Kept in sync by refreshModels; the slash command reads from here so it
// always reflects the currently registered catalog.
let currentModels: RegisteredModel[] = [];

function hasFeature(model: NebiusTokenFactoryModel, feature: string): boolean {
	return (model.supported_features ?? []).includes(feature);
}

function hasImageInput(model: NebiusTokenFactoryModel): boolean {
	const inputSide = (model.architecture?.modality ?? "").split("->")[0] ?? "";
	return inputSide.includes("image");
}

function parseCostPerMillion(raw: string | undefined): number {
	if (!raw) return 0;
	const value = Number.parseFloat(raw);
	return Number.isFinite(value) ? value * 1_000_000 : 0;
}

function toRegisteredModel(model: NebiusTokenFactoryModel): RegisteredModel | undefined {
	if (!hasFeature(model, "tools")) return undefined;

	const contextWindow =
		model.context_length && model.context_length > 0 ? model.context_length : DEFAULT_CONTEXT_WINDOW;
	const input: ("text" | "image")[] = hasImageInput(model) ? ["text", "image"] : ["text"];

	return {
		id: model.id,
		name: model.id,
		reasoning: hasFeature(model, "reasoning"),
		input,
		cost: {
			input: parseCostPerMillion(model.pricing?.prompt),
			output: parseCostPerMillion(model.pricing?.completion),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens: Math.min(contextWindow, MAX_OUTPUT_TOKENS),
		compat: {
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	};
}

class CatalogFetchTimeoutError extends Error {
	constructor() {
		super("catalog fetch timed out");
		this.name = "CatalogFetchTimeoutError";
	}
}

/**
 * Fetch the catalog with a per-attempt timeout, aborting when the caller's
 * signal fires. Throws `CatalogFetchTimeoutError` on timeout.
 */
async function fetchCatalog(apiKey: string, signal: AbortSignal, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new CatalogFetchTimeoutError()), timeoutMs);
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await fetch(`${BASE_URL}/models?verbose=true`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

type FetchAttemptResult =
	| { kind: "ok"; models: RegisteredModel[] }
	| { kind: "fatal"; reason: string }
	| { kind: "retryable"; reason: string }
	| { kind: "aborted" };

async function attemptFetch(
	apiKey: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<FetchAttemptResult> {
	if (signal.aborted) return { kind: "aborted" };

	let response: Response;
	try {
		response = await fetchCatalog(apiKey, signal, timeoutMs);
	} catch (error) {
		if (signal.aborted) return { kind: "aborted" };
		if (error instanceof CatalogFetchTimeoutError) {
			return { kind: "retryable", reason: "catalog fetch timed out" };
		}
		return {
			kind: "retryable",
			reason: `network error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (!response.ok) {
		const reason = `API returned ${response.status} ${response.statusText}`;
		// 429 and 5xx are transient; other 4xx (bad key, unknown endpoint) will
		// not succeed on retry.
		if (response.status === 429 || response.status >= 500) return { kind: "retryable", reason };
		return { kind: "fatal", reason };
	}

	try {
		const json = (await response.json()) as { data?: unknown };
		if (!Array.isArray(json.data)) {
			return { kind: "retryable", reason: "Unexpected API response shape" };
		}

		const models = (json.data as NebiusTokenFactoryModel[]).flatMap((model) => {
			const registeredModel = toRegisteredModel(model);
			return registeredModel ? [registeredModel] : [];
		});
		return { kind: "ok", models };
	} catch (error) {
		return {
			kind: "retryable",
			reason: `Invalid API response: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Fetch the model catalog, retrying transient failures (timeouts, network
 * errors, HTTP 429/5xx, invalid responses) with backoff. Fails fast on
 * permanent errors such as a bad API key. Returns undefined when all attempts
 * fail or the caller's signal aborts.
 */
async function fetchModels(
	apiKey: string,
	signal: AbortSignal,
	options: { timeoutMs?: number; maxAttempts?: number } = {},
): Promise<RegisteredModel[] | undefined> {
	const { timeoutMs = FETCH_TIMEOUT_MS, maxAttempts = MAX_FETCH_ATTEMPTS } = options;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			if (signal.aborted) return undefined;
			await sleep(FETCH_RETRY_BACKOFF_MS[attempt - 1] ?? 0, signal);
		}

		const result = await attemptFetch(apiKey, signal, timeoutMs);
		switch (result.kind) {
			case "ok":
				return result.models;
			case "fatal":
				console.warn(`[${PROVIDER_NAME}] ${result.reason}`);
				return undefined;
			case "aborted":
				return undefined;
			case "retryable":
				console.warn(`[${PROVIDER_NAME}] ${result.reason} (attempt ${attempt + 1} of ${maxAttempts})`);
		}
	}

	console.warn(`[${PROVIDER_NAME}] Catalog fetch failed after ${maxAttempts} attempts`);
	return undefined;
}

/**
 * Read our entry from pi's persisted provider store (the file we write via
 * `context.publish({ persist })`). Seeding `models:` at registration with the
 * last-known-good catalog keeps the models visible in the model picker while
 * pi's refresh is still running: the picker reads pi's snapshot, which is only
 * rebuilt when the refresh settles, so an empty registration list means no
 * models for the whole refresh duration.
 *
 * Best-effort: returns undefined on any error (missing file, unreadable,
 * malformed JSON, unknown store layout), in which case the extension behaves
 * as before. The store format is pi-internal (JSON object keyed by provider
 * ID), so the read is guarded and only the models array for this provider is
 * used. `getAgentDir` is accessed via the namespace with an optional call so
 * old pi versions without the export do not break the extension.
 */
function readCachedModels(): RegisteredModel[] | undefined {
	try {
		const getAgentDir = (piCodingAgent as { getAgentDir?: () => string }).getAgentDir;
		if (!getAgentDir) return undefined;

		const storePath = join(getAgentDir(), "models-store.json");
		const data = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
		const entry = data[PROVIDER_NAME];
		if (!entry || typeof entry !== "object") return undefined;

		const models = (entry as { models?: unknown }).models;
		if (!Array.isArray(models)) return undefined;

		const validModels = models.filter(
			(m): m is RegisteredModel => typeof (m as { id?: unknown } | null)?.id === "string",
		);
		return validModels.length > 0 ? validModels : undefined;
	} catch {
		return undefined;
	}
}

export default async function (pi: ExtensionAPI) {
	// Pi does not invoke refreshModels in non-interactive modes (e.g.
	// `pi --list-models`), so pre-fetch with the environment key when it is
	// set. Without a key the provider still registers (with no models) so
	// it shows up in /login; refreshModels then loads the catalog once a
	// key is saved. The pre-fetch uses a tighter timeout/retry budget
	// because it blocks extension load.
	const initialKey = process.env[API_KEY_ENV_VAR];
	const initialModels = initialKey
		? await fetchModels(initialKey, new AbortController().signal, {
				timeoutMs: PREFETCH_TIMEOUT_MS,
				maxAttempts: PREFETCH_MAX_ATTEMPTS,
			})
		: undefined;
	// Seed from the persisted last-known-good catalog when the pre-fetch
	// produced nothing (no env key, or the API was unreachable). Registering
	// with the cached list keeps the models selectable while pi's refresh is
	// still in flight; the picker reads pi's snapshot, which only reflects
	// the registered models until the refresh settles.
	const cachedModels = readCachedModels();
	currentModels = initialModels ?? cachedModels ?? [];

	pi.registerProvider(PROVIDER_NAME, {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: BASE_URL,
		apiKey: API_KEY_ENV_REF,
		api: "openai-completions",
		models: currentModels,
		refreshModels: async (context) => {
			// Pi calls refreshModels at startup and after /login in
			// interactive sessions, first with allowNetwork=false to restore
			// the persisted catalog, then with network access and the
			// effective credential. Without a usable key we keep the current
			// list; the provider stays visible in /login either way.
			if (!context.allowNetwork) {
				// Cold start with an unreachable API: seed from the persisted
				// last-known-good catalog instead of publishing an empty list.
				if (currentModels.length === 0 && context.stored && Array.isArray(context.stored.models)) {
					currentModels = context.stored.models as unknown as RegisteredModel[];
				}
				return currentModels;
			}

			const credential = context.credential;
			if (credential?.type !== "api_key" || !credential.key) return currentModels;

			const refreshed = await fetchModels(credential.key, context.signal);
			// Keep the last-known-good list when the fetch fails; the provider
			// must not lose its models because of a transient outage.
			if (!refreshed) return currentModels;

			currentModels = refreshed;
			// Write-through: persist the catalog so a later session can restore
			// it offline. The cast is required because pi-ai's
			// ModelsStoreEntry/Model types are not re-exported by
			// pi-coding-agent; only this extension writes and reads the
			// provider's store entry, so the shapes always match. A store
			// failure must not fail the refresh, so it is logged and ignored.
			try {
				const entry = {
					models: refreshed,
					checkedAt: Date.now(),
				} as unknown as Parameters<typeof context.publish>[0]["persist"];
				await context.publish({ persist: entry });
			} catch (error) {
				console.warn(`[${PROVIDER_NAME}] Failed to persist model catalog:`, error);
			}

			return refreshed;
		},
	});

	pi.registerCommand("nebius-token-factory-models", {
		description: "List available Nebius Token Factory models",
		handler: async (_args, ctx) => {
			if (currentModels.length === 0) {
				ctx.ui.notify("No Nebius Token Factory models available", "warning");
				return;
			}

			const items = [...currentModels]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => {
					const tags = [];
					if (model.reasoning) tags.push("reasoning");
					if (model.input.includes("image")) tags.push("vision");
					return tags.length > 0 ? `${model.id} (${tags.join(", ")})` : model.id;
				});

			await ctx.ui.select(`${PROVIDER_DISPLAY_NAME} — ${currentModels.length} models`, items);
		},
	});
}
