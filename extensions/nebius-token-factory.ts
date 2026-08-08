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

async function fetchModels(): Promise<RegisteredModel[] | undefined> {
	const apiKey = process.env[API_KEY_ENV_VAR];
	if (!apiKey) {
		console.warn(`[${PROVIDER_NAME}] ${API_KEY_ENV_VAR} is not set; no provider registered`);
		return undefined;
	}

	try {
		const res = await fetch(`${BASE_URL}/models?verbose=true`, {
			headers: { Authorization: `Bearer ${apiKey}` },
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
		console.warn(`[${PROVIDER_NAME}] Failed to fetch models:`, error);
		return undefined;
	}
}

export default async function (pi: ExtensionAPI) {
	const models = await fetchModels();
	if (!models) return;

	pi.registerProvider(PROVIDER_NAME, {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: BASE_URL,
		apiKey: API_KEY_ENV_REF,
		api: "openai-completions",
		models,
	});

	pi.registerCommand("nebius-token-factory-models", {
		description: "List available Nebius Token Factory models",
		handler: async (_args, ctx) => {
			if (models.length === 0) {
				ctx.ui.notify("No Nebius Token Factory models available", "warning");
				return;
			}

			const items = [...models]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => {
					const tags = [];
					if (model.reasoning) tags.push("reasoning");
					if (model.input.includes("image")) tags.push("vision");
					return tags.length > 0 ? `${model.id} (${tags.join(", ")})` : model.id;
				});

			await ctx.ui.select(`${PROVIDER_DISPLAY_NAME} — ${models.length} models`, items);
		},
	});
}
