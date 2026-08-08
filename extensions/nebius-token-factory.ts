import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "nebius-token-factory";
const PROVIDER_DISPLAY_NAME = "Nebius Token Factory";
const BASE_URL = "https://api.tokenfactory.nebius.com/v1";
const API_KEY_ENV_VAR = "NEBIUS_TOKEN_FACTORY_API_KEY";
const API_KEY_ENV_REF = `$${API_KEY_ENV_VAR}`;
const DEFAULT_CONTEXT_WINDOW = 131072;
const MAX_OUTPUT_TOKENS = 32768;

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

interface NebiusTokenFactoryModelsResponse {
	data: NebiusTokenFactoryModel[];
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

async function fetchModels(apiKey: string, signal: AbortSignal): Promise<RegisteredModel[] | undefined> {
	try {
		const res = await fetch(`${BASE_URL}/models?verbose=true`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (!res.ok) {
			console.warn(`[${PROVIDER_NAME}] API returned ${res.status}: ${res.statusText}`);
			return undefined;
		}

		const response = (await res.json()) as NebiusTokenFactoryModelsResponse;
		if (!Array.isArray(response.data)) {
			console.warn(`[${PROVIDER_NAME}] Unexpected API response shape`);
			return undefined;
		}

		return response.data.flatMap((model) => {
			const registeredModel = toRegisteredModel(model);
			return registeredModel ? [registeredModel] : [];
		});
	} catch (error) {
		if (!signal.aborted) {
			console.warn(`[${PROVIDER_NAME}] Failed to fetch models:`, error);
		}
		return undefined;
	}
}

export default async function (pi: ExtensionAPI) {
	// Pi does not invoke refreshModels in non-interactive modes (e.g.
	// `pi --list-models`), so pre-fetch with the environment key when it is
	// set. Without a key the provider still registers (with no models) so
	// it shows up in /login; refreshModels then loads the catalog once a
	// key is saved.
	const initialKey = process.env[API_KEY_ENV_VAR];
	const initialModels = initialKey ? await fetchModels(initialKey, new AbortController().signal) : undefined;
	if (initialModels) currentModels = initialModels;

	pi.registerProvider(PROVIDER_NAME, {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: BASE_URL,
		apiKey: API_KEY_ENV_REF,
		api: "openai-completions",
		models: initialModels ?? [],
		refreshModels: async (context) => {
			// Pi calls refreshModels at startup and after /login in
			// interactive sessions. Without a usable key we keep the
			// current list; the provider stays visible in /login either way.
			if (!context.allowNetwork) return currentModels;
			const credential = context.credential;
			if (credential?.type !== "api_key" || !credential.key) return currentModels;

			const refreshed = await fetchModels(credential.key, context.signal);
			if (!refreshed) return currentModels;
			currentModels = refreshed;
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
