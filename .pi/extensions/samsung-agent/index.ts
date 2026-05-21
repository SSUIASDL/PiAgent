import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "samsung-agent";
const DEFAULT_BASE_URL = "https://agent.sec.samsung.net/api/v1/run";
const DEFAULT_ENDPOINT = process.env.SAMSUNG_AGENT_ENDPOINT || "samsung-agent-endpoint";

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content ?? "");

	return content
		.map((block: any) => {
			if (!block) return "";
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return `[thinking]\n${block.thinking ?? ""}`;
			if (block.type === "toolCall") return `[tool call: ${block.name}]\n${JSON.stringify(block.arguments ?? {})}`;
			if (block.type === "image") return "[image omitted: Samsung Agent API currently receives text only]";
			return JSON.stringify(block);
		})
		.filter(Boolean)
		.join("\n");
}

function messageToText(message: Message): string {
	if (message.role === "toolResult") {
		return `tool result (${message.toolName ?? message.toolCallId}${message.isError ? ", error" : ""}):\n${contentToText(message.content)}`;
	}
	return `${message.role}:\n${contentToText((message as any).content)}`;
}

function contextToInputValue(context: Context): string {
	const parts: string[] = [];

	if (context.systemPrompt?.trim()) {
		parts.push(`system:\n${context.systemPrompt.trim()}`);
	}

	if (context.tools?.length) {
		parts.push(
			`available local tools (do not execute these on the server; if a tool is needed, respond with ONLY tool-call JSON in the format below so pi can execute it locally):\n${context.tools
				.map((tool: any) => {
					const schema = tool.inputSchema ?? tool.parameters ?? tool.schema ?? {};
					return `- ${tool.name}: ${tool.description ?? ""}\n  arguments_schema: ${JSON.stringify(schema)}`;
				})
				.join("\n")}\n\nTool-call response format (no markdown, no extra text):\n{"tool_calls":[{"name":"tool_name","arguments":{}}]}\n\nIf no tool is needed, respond with normal assistant text only.`,
		);
	}

	parts.push(...context.messages.map(messageToText));
	return parts.join("\n\n---\n\n");
}

function extractText(value: any): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);

	if (Array.isArray(value)) return value.map(extractText).join("");

	return (
		value.output ??
		value.text ??
		value.content ??
		value.message ??
		value.response ??
		value.answer ??
		value.result ??
		value.output_value ??
		value.outputs?.[0]?.outputs?.[0]?.results?.message?.text ??
		value.outputs?.[0]?.outputs?.[0]?.artifacts?.message ??
		""
	).toString();
}

function usageFromResponse(value: any) {
	const usage = value?.usage ?? value?.token_usage ?? value?.data?.usage ?? {};
	return {
		input: Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.input ?? 0) || 0,
		output: Number(usage.output_tokens ?? usage.completion_tokens ?? usage.output ?? 0) || 0,
	};
}

function isSseLine(line: string): boolean {
	return line.startsWith("data:") || line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:");
}

function parseChunkText(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed || trimmed === "[DONE]") return "";

	const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
	if (!payload || payload === "[DONE]") return "";

	try {
		const json = JSON.parse(payload);
		if (json?.tool_calls || json?.toolCalls || json?.type === "tool_call" || json?.type === "toolCall") return JSON.stringify(json);
		return extractText(json);
	} catch {
		return isSseLine(trimmed) ? "" : payload;
	}
}

function pushDelta(stream: AssistantMessageEventStream, output: AssistantMessage, state: { started: boolean; text: string }, delta: string) {
	if (!delta) return;
	if (!state.started) {
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		state.started = true;
	}

	state.text += delta;
	const block = output.content[output.content.length - 1];
	if (block?.type === "text") block.text = state.text;
	stream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta, partial: output });
}

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenced ? fenced[1].trim() : trimmed;
}

function extractToolCalls(text: string, context: Context): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
	const available = new Set((context.tools ?? []).map((tool) => tool.name));
	if (!available.size) return [];

	let parsed: any;
	try {
		parsed = JSON.parse(stripJsonFence(text));
	} catch {
		const jsonObject = stripJsonFence(text).match(/\{[\s\S]*\}/)?.[0];
		if (!jsonObject) return [];
		try {
			parsed = JSON.parse(jsonObject);
		} catch {
			return [];
		}
	}

	const rawCalls = Array.isArray(parsed?.tool_calls)
		? parsed.tool_calls
		: Array.isArray(parsed?.toolCalls)
			? parsed.toolCalls
			: parsed?.type === "tool_call" || parsed?.type === "toolCall" || parsed?.name
				? [parsed]
				: [];

	return rawCalls
		.map((call: any, index: number) => ({
			id: String(call.id ?? `samsung-agent-tool-${Date.now()}-${index}`),
			name: String(call.name ?? call.tool_name ?? call.toolName ?? ""),
			arguments: call.arguments ?? call.args ?? call.input ?? {},
		}))
		.filter((call) => available.has(call.name) && call.arguments && typeof call.arguments === "object");
}

function pushToolCalls(stream: AssistantMessageEventStream, output: AssistantMessage, toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
	for (const toolCall of toolCalls) {
		const contentIndex = output.content.length;
		output.content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} });
		stream.push({ type: "toolcall_start", contentIndex, partial: output });

		const delta = JSON.stringify(toolCall.arguments);
		const block = output.content[contentIndex];
		if (block?.type === "toolCall") block.arguments = toolCall.arguments;
		stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
		stream.push({ type: "toolcall_end", contentIndex, toolCall: { type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }, partial: output });
	}
}

export function streamSamsungAgent(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("SAMSUNG_AGENT_API_KEY is not configured. Set it as an environment variable or via /login/API key storage.");

			const endpoint = process.env.SAMSUNG_AGENT_ENDPOINT || model.id;
			if (!endpoint || endpoint === "samsung-agent-endpoint") {
				throw new Error("SAMSUNG_AGENT_ENDPOINT is not configured. Set it to the {endpoint} value from the Samsung Agent API URL.");
			}

			const baseUrl = process.env.SAMSUNG_AGENT_BASE_URL || model.baseUrl || DEFAULT_BASE_URL;
			const url = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(endpoint)}?stream=true`;

			stream.push({ type: "start", partial: output });

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
				},
				body: JSON.stringify({
					input_type: "chat",
					output_type: "chat",
					input_value: contextToInputValue(context),
				}),
				signal: options?.signal,
			});

			if (!response.ok) {
				throw new Error(`Samsung Agent API request failed: ${response.status} ${response.statusText} - ${await response.text()}`);
			}

			const state = { started: false, text: "" };
			const contentType = response.headers.get("content-type") ?? "";
			let assistantText = "";

			if (response.body && (contentType.includes("text/event-stream") || contentType.includes("stream"))) {
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let receivedDone = false;

				while (!receivedDone) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					const lines = buffer.split(/\r?\n/);
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						const payload = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : line.trim();
						if (payload === "[DONE]") {
							receivedDone = true;
							break;
						}
						const delta = parseChunkText(line);
						assistantText += delta;
						pushDelta(stream, output, state, delta);
					}
				}

				if (!receivedDone) {
					const delta = parseChunkText(buffer);
					assistantText += delta;
					pushDelta(stream, output, state, delta);
				}
			} else {
				const raw = await response.text();
				let parsed: any = raw;
				try {
					parsed = JSON.parse(raw);
					const usage = usageFromResponse(parsed);
					output.usage.input = usage.input;
					output.usage.output = usage.output;
					output.usage.totalTokens = usage.input + usage.output;
					calculateCost(model, output.usage);
				} catch {}
				assistantText = extractText(parsed) || raw;
			}

			const toolCalls = extractToolCalls(assistantText, context);
			if (toolCalls.length) {
				output.stopReason = "toolUse";
				pushToolCalls(stream, output, toolCalls);
				stream.push({ type: "done", reason: "toolUse", message: output });
			} else {
				if (!state.started) pushDelta(stream, output, state, assistantText);
				if (state.started) stream.push({ type: "text_end", contentIndex: output.content.length - 1, content: state.text, partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
			}
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: "Samsung Agent",
		baseUrl: DEFAULT_BASE_URL,
		apiKey: "SAMSUNG_AGENT_API_KEY",
		api: "samsung-agent-api",
		models: [
			{
				id: DEFAULT_ENDPOINT,
				name: "Samsung Agent Endpoint",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
		streamSimple: streamSamsungAgent,
	});
}
