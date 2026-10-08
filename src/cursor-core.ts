import { Agent, Cursor } from "@cursor/sdk";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_API_KEY_PLACEHOLDER = "pi-cursor-auth-placeholder";

const MODEL_ALIASES: Record<string, string> = {
  "auto-smart": "default",
  auto: "default",
};

// Empty until a live catalog loads in this process.
const knownModelIds = new Set<string>();
const require = createRequire(import.meta.url);

const CURSOR_PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@cursor/sdk-darwin-arm64",
  "darwin-x64": "@cursor/sdk-darwin-x64",
  "linux-arm64": "@cursor/sdk-linux-arm64",
  "linux-x64": "@cursor/sdk-linux-x64",
  "win32-x64": "@cursor/sdk-win32-x64",
};

function bundledRipgrepPath(): string | undefined {
  const packageName = CURSOR_PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!packageName) return undefined;

  for (const binary of process.platform === "win32" ? ["bin/rg.exe", "bin/rg"] : ["bin/rg"]) {
    try {
      const path = require.resolve(`${packageName}/${binary}`);
      if (existsSync(path)) return path;
    } catch {
      // The platform package is an optional dependency.
    }
  }
  return undefined;
}

/**
 * The Cursor SDK expects its bundled ripgrep path to be configured by its
 * host. npm exposes the binary as a package bin, but Pi does not add that
 * package's bin directory to PATH.
 */
export function configureCursorRipgrepPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.CURSOR_RIPGREP_PATH?.trim();
  if (configured) return configured;

  const bundled = bundledRipgrepPath();
  if (bundled) env.CURSOR_RIPGREP_PATH = bundled;
  return bundled;
}

export function setKnownModelIds(ids: string[]): void {
  knownModelIds.clear();
  for (const id of ids) knownModelIds.add(id);
  if (knownModelIds.size) knownModelIds.add("default");
}

function resolveModelId(requested: string): string {
  if (MODEL_ALIASES[requested]) return MODEL_ALIASES[requested];
  // Before a live catalog loads, keep the requested ID. pi's cached catalog
  // came from Cursor, so a cached model such as grok-4.7 is valid.
  if (!knownModelIds.size) return requested;
  return knownModelIds.has(requested) ? requested : "default";
}

export function resolveCursorApiKey(
  raw: string | undefined,
  opts: { env?: string | undefined; stored?: string | undefined } = {},
): string | undefined {
  if (raw && raw !== CURSOR_API_KEY_PLACEHOLDER) return raw.trim() || undefined;
  const envKey = opts.env?.trim();
  if (envKey) return envKey;
  return opts.stored?.trim() || undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block?.type === "text") parts.push(block.text ?? "");
  }
  return parts.join("\n");
}

function asObject(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

export function extractLastUserImages(context: any): any[] | undefined {
  const messages: any[] = context?.messages ?? [];
  let lastUser: any = null;
  for (const m of messages) if (m?.role === "user") lastUser = m;
  if (!lastUser || typeof lastUser.content === "string") return undefined;
  const images: any[] = [];
  for (const block of lastUser.content ?? []) {
    if (block?.type === "image") {
      images.push({ data: block.data, mimeType: block.mimeType });
    }
  }
  return images.length ? images : undefined;
}

function formatMessage(message: any): string {
  if (message?.role === "user") {
    return `[user]\n${textFromContent(message.content)}`;
  }
  if (message?.role === "assistant") {
    const parts: string[] = [];
    for (const block of message.content ?? []) {
      if (block?.type === "text" && block.text) parts.push(block.text);
      else if (block?.type === "toolCall") {
        parts.push(
          `[tool_call ${block.name} ${block.id}]\n${JSON.stringify(block.arguments ?? {}, null, 2)}`,
        );
      }
    }
    return `[assistant]\n${parts.join("\n")}`;
  }
  if (message?.role === "toolResult") {
    const err = message.isError ? " error" : "";
    return `[tool_result ${message.toolName ?? "tool"} ${message.toolCallId ?? ""}${err}]\n${textFromContent(message.content)}`;
  }
  return "";
}

export function buildHarnessPrompt(context: any): string {
  const parts: string[] = [
    "Use only the tools provided on this request. Do not use Cursor built-in file, shell, or edit tools. After a tool call, wait for the tool result in the next turn.",
  ];
  const system = context?.systemPrompt?.trim();
  if (system) parts.push(system);
  const messages: any[] = context?.messages ?? [];
  if (messages.length) {
    parts.push("## Conversation");
    for (const message of messages) {
      const formatted = formatMessage(message);
      if (formatted) parts.push(formatted);
    }
  }
  return parts.join("\n\n");
}

const MCP_META = new Set([
  "mcp",
  "CallMcpTool",
  "call_mcp_tool",
  "GetMcpTools",
  "get_mcp_tools",
]);

export function unwrapCursorToolCall(
  name: string | undefined,
  args: unknown,
  id: string,
  allowedNames?: Set<string>,
): { id: string; name: string; arguments: Record<string, any> } | null {
  if (!name) return null;
  if (name === "GetMcpTools" || name === "get_mcp_tools") return null;

  let toolName = name;
  let toolArgs = asObject(args);

  if (MCP_META.has(name) || /mcp/i.test(name)) {
    toolName = toolArgs.toolName || toolArgs.tool_name || toolArgs.name || "";
    toolArgs = asObject(
      toolArgs.arguments ?? toolArgs.input ?? toolArgs.args ?? {},
    );
  }
  if (toolName.startsWith("pi__")) toolName = toolName.slice(4);
  if (!toolName) return null;
  if (
    allowedNames?.size &&
    !allowedNames.has(toolName) &&
    !allowedNames.has(name)
  ) {
    return null;
  }
  return { id, name: toolName, arguments: toolArgs };
}

export function collectToolCalls(
  content: any[] | undefined,
  allowedNames?: Set<string>,
): any[] {
  const calls: any[] = [];
  for (const block of content ?? []) {
    if (block?.type !== "tool_use") continue;
    const call = unwrapCursorToolCall(
      block.name,
      block.input,
      block.id || `call_${calls.length + 1}`,
      allowedNames,
    );
    if (call) calls.push(call);
  }
  return calls;
}

export function thinkingParams(
  model: any,
  reasoning: string | undefined,
): any[] | undefined {
  if (!reasoning || reasoning === "off") return undefined;
  const defs = model?.cursorParameters ?? model?.parameters ?? [];
  if (!Array.isArray(defs) || !defs.length) return undefined;
  const def = defs.find(
    (d: any) =>
      /reason|think|effort/i.test(d?.id ?? "") ||
      /reason|think|effort/i.test(d?.displayName ?? ""),
  );
  if (!def?.id) return undefined;
  const values = (def.values ?? []).map((v: any) => v?.value ?? v);
  const value = values.includes(reasoning) ? reasoning : values[0];
  if (!value) return undefined;
  return [{ id: def.id, value: String(value) }];
}

function toCustomTools(
  tools: any[],
  onCall: (call: {
    id: string;
    name: string;
    arguments: Record<string, any>;
  }) => void,
  park: () => Promise<void>,
): Record<string, any> {
  const custom: Record<string, any> = {};
  for (const tool of tools) {
    if (!tool?.name) continue;
    const schema =
      tool.parameters && typeof tool.parameters === "object"
        ? tool.parameters
        : { type: "object", properties: {} };
    custom[tool.name] = {
      description: tool.description || tool.name,
      inputSchema: schema,
      execute: async (args: any, ctx: any) => {
        onCall({
          id: ctx?.toolCallId || `call_${tool.name}`,
          name: tool.name,
          arguments: asObject(args),
        });
        await park();
        return {
          content: [{ type: "text", text: "handed to pi" }],
          isError: true,
        };
      },
    };
  }
  return custom;
}

export const CURSOR_API = "cursor-sdk";
export const CURSOR_BASE_URL = "https://cursor.com";
export const CURSOR_COMPAT_SOURCE_ID = "pi-cursor-auth";

/**
 * Bridge the native provider streams to pi-ai's legacy compatibility registry.
 * Some extensions (notably Hermes Memory) use compat.completeSimple() for
 * side-channel requests rather than the active ModelRegistry.
 */
export function createCursorCompatApiProvider(streams: {
  stream: (...args: any[]) => any;
  streamSimple: (...args: any[]) => any;
}): { api: string; stream: (...args: any[]) => any; streamSimple: (...args: any[]) => any } {
  return {
    api: CURSOR_API,
    stream: streams.stream,
    streamSimple: streams.streamSimple,
  };
}

function toPiModel(m: any): any {
  return {
    id: m.id,
    name: m.displayName || m.id,
    api: CURSOR_API,
    provider: CURSOR_PROVIDER_ID,
    baseUrl: CURSOR_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
    cursorParameters: m.parameters,
  };
}

const FALLBACK_MODELS: any[] = [
  toPiModel({ id: "default", displayName: "Cursor Default" }),
  toPiModel({ id: "claude-opus-5", displayName: "Claude Opus 5" }),
  toPiModel({ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" }),
  toPiModel({ id: "grok-4.6", displayName: "Grok 4.6" }),
  toPiModel({ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }),
];

export function fallbackModels(): any[] {
  return FALLBACK_MODELS;
}


export async function discoverCursorModels(
  apiKey: string | undefined,
): Promise<any[]> {
  if (!apiKey) return [];
  try {
    const models = await Cursor.models.list({ apiKey });
    const mapped = (models ?? []).map(toPiModel);
    if (mapped.length) setKnownModelIds(mapped.map((m: any) => m.id));
    return mapped;
  } catch {
    return [];
  }
}

interface TurnDeps {
  createStream: () => any;
  calculateCost: (model: any, usage: any) => void;
  createAgent?: (opts: any) => Promise<any>;
}

function makeInitialMessage(model: any): any {
  return {
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
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function applyUsage(
  output: any,
  tokenUsage: any,
  model: any,
  calculateCost: any,
): void {
  if (!tokenUsage) return;
  output.usage.input = tokenUsage.inputTokens ?? 0;
  output.usage.output = tokenUsage.outputTokens ?? 0;
  output.usage.cacheRead = tokenUsage.cacheReadTokens ?? 0;
  output.usage.cacheWrite = tokenUsage.cacheWriteTokens ?? 0;
  output.usage.totalTokens =
    tokenUsage.totalTokens ??
    output.usage.input +
      output.usage.output +
      output.usage.cacheRead +
      output.usage.cacheWrite;
  try {
    calculateCost(model, output.usage);
  } catch {
    /* ignore cost calc errors */
  }
}

function makeBlockAppenders(output: any, stream: any) {
  let openTextIdx = -1;
  let openText = "";
  let openThinkIdx = -1;
  let openThink = "";

  const closeThinking = () => {
    if (openThinkIdx === -1) return;
    stream.push({
      type: "thinking_end",
      contentIndex: openThinkIdx,
      content: openThink,
      partial: output,
    });
    openThinkIdx = -1;
  };
  const closeText = () => {
    if (openTextIdx === -1) return;
    stream.push({
      type: "text_end",
      contentIndex: openTextIdx,
      content: openText,
      partial: output,
    });
    openTextIdx = -1;
  };

  const appendThinking = (chunk: string) => {
    if (!chunk) return;
    if (openThinkIdx === -1) {
      output.content.push({ type: "thinking", thinking: "" });
      openThinkIdx = output.content.length - 1;
      stream.push({
        type: "thinking_start",
        contentIndex: openThinkIdx,
        partial: output,
      });
    }
    openThink += chunk;
    output.content[openThinkIdx].thinking = openThink;
    stream.push({
      type: "thinking_delta",
      contentIndex: openThinkIdx,
      delta: chunk,
      partial: output,
    });
  };

  const appendText = (text: string) => {
    if (!text) return;
    if (openThinkIdx !== -1) closeThinking();
    if (openTextIdx === -1) {
      output.content.push({ type: "text", text: "" });
      openTextIdx = output.content.length - 1;
      stream.push({
        type: "text_start",
        contentIndex: openTextIdx,
        partial: output,
      });
    }
    openText += text;
    output.content[openTextIdx].text = openText;
    stream.push({
      type: "text_delta",
      contentIndex: openTextIdx,
      delta: text,
      partial: output,
    });
  };

  const emitToolCalls = (calls: any[]) => {
    closeThinking();
    closeText();
    const seen = new Set<string>();
    for (const call of calls) {
      const key = call.id || `${call.name}:${JSON.stringify(call.arguments)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.content.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? {},
      });
      const idx = output.content.length - 1;
      const json = JSON.stringify(call.arguments ?? {});
      stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
      stream.push({
        type: "toolcall_delta",
        contentIndex: idx,
        delta: json,
        partial: output,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex: idx,
        toolCall: output.content[idx],
        partial: output,
      });
    }
  };

  return { appendThinking, appendText, closeThinking, closeText, emitToolCalls };
}

export function runCursorTurn(opts: {
  model: any;
  context: any;
  options?: any;
  apiKey: string | undefined;
  deps: TurnDeps;
}): any {
  const { model, context, options, apiKey, deps } = opts;
  const stream = deps.createStream();
  const createAgent = deps.createAgent ?? ((o: any) => Agent.create(o));

  (async () => {
    const output = makeInitialMessage(model);
    const blocks = makeBlockAppenders(output, stream);
    stream.push({ type: "start", partial: output });

    if (!apiKey) {
      output.stopReason = "error";
      output.errorMessage =
        "No Cursor API key. Set CURSOR_API_KEY, run /login, or use /cursor-auth.";
      stream.push({ type: "error", reason: "error", error: output });
      stream.end(output);
      return;
    }

    const modelId = resolveModelId(model.id);
    let agent: any;
    let run: any;
    const captured: any[] = [];
    const allowedNames = new Set<string>(
      (context?.tools ?? [])
        .map((t: any) => t?.name)
        .filter((name: unknown): name is string => typeof name === "string"),
    );
    const remember = (calls: any[]) => {
      for (const call of calls) {
        if (!call) continue;
        captured.push(call);
      }
    };
    const handoff = new AbortController();
    const cancelRun = () => {
      try {
        void Promise.resolve(run?.cancel?.()).catch(() => {});
      } catch {
        /* ignore cancellation errors */
      }
    };
    const park = () =>
      new Promise<void>((resolve) => {
        if (handoff.signal.aborted) {
          resolve();
          return;
        }
        handoff.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    let handoffTimer: ReturnType<typeof setTimeout> | undefined;
    const requestHandoff = () => {
      if (handoffTimer) return;
      handoffTimer = setTimeout(() => {
        handoff.abort();
        cancelRun();
      }, 50);
    };

    try {
      const piTools: any[] = context?.tools ?? [];
      let prompt = buildHarnessPrompt(context);
      const images = extractLastUserImages(context);
      const params = thinkingParams(model, options?.reasoning);
      let payload: any = {
        text: prompt,
        images,
        modelId,
        tools: piTools.map((t) => t.name),
        params,
      };
      if (options?.onPayload) {
        const replaced = await options.onPayload(payload, model);
        if (replaced && typeof replaced === "object") payload = replaced;
      }
      prompt = payload.text ?? prompt;

      configureCursorRipgrepPath();
      agent = await createAgent({
        model: {
          id: payload.modelId ?? modelId,
          ...(payload.params?.length ? { params: payload.params } : {}),
        },
        apiKey,
        tools: piTools.length ? ["mcp"] : [],
        local: {
          cwd: process.cwd(),
          settingSources: [],
          customTools: piTools.length
            ? toCustomTools(piTools, (call) => {
                remember([call]);
                requestHandoff();
              }, park)
            : undefined,
        },
      });

      const userMessage = payload.images?.length
        ? { text: prompt, images: payload.images }
        : prompt;
      run = await agent.send(userMessage, {});

      const onAbort = () => {
        handoff.abort();
        cancelRun();
      };
      if (options?.signal?.aborted) onAbort();
      options?.signal?.addEventListener?.("abort", onAbort, { once: true });

      for await (const msg of run.stream()) {
        if (options?.signal?.aborted || handoff.signal.aborted) break;
        if (msg?.type === "thinking") {
          blocks.appendThinking(msg.text);
        } else if (msg?.type === "assistant") {
          const content = msg.message?.content ?? [];
          for (const block of content) {
            if (block?.type === "text") blocks.appendText(block.text);
          }
          const calls = collectToolCalls(content, allowedNames);
          if (calls.length) {
            remember(calls);
            requestHandoff();
          }
        } else if (msg?.type === "tool_call" && msg.name) {
          const call = unwrapCursorToolCall(
            msg.name,
            msg.args,
            msg.call_id || `call_${captured.length + 1}`,
            allowedNames,
          );
          if (call) {
            remember([call]);
            requestHandoff();
          }
        } else if (msg?.type === "usage") {
          applyUsage(output, msg.usage, model, deps.calculateCost);
        }
      }

      let result: any;
      try {
        result = await run.wait();
      } catch {
        result = undefined;
      }
      if (result?.usage)
        applyUsage(output, result.usage, model, deps.calculateCost);

      if (captured.length) {
        blocks.emitToolCalls(captured);
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else if (options?.signal?.aborted || result?.status === "cancelled") {
        blocks.closeThinking();
        blocks.closeText();
        output.stopReason = "aborted";
        output.errorMessage = result?.error?.message || "Cursor run cancelled";
        stream.push({ type: "error", reason: "aborted", error: output });
      } else if (result?.status === "finished" || !result) {
        blocks.closeThinking();
        blocks.closeText();
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
      } else {
        blocks.closeThinking();
        blocks.closeText();
        output.stopReason = "error";
        output.errorMessage = result?.error?.message || "Cursor run failed";
        stream.push({ type: "error", reason: "error", error: output });
      }
    } catch (err) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      if (handoffTimer) clearTimeout(handoffTimer);
      try {
        handoff.abort();
      } catch {
        /* ignore */
      }
      try {
        agent?.close?.();
      } catch {
        /* ignore */
      }
      stream.end(output);
    }
  })();

  return stream;
}

export function createCursorStreams(deps: TurnDeps) {
  const stream = (model: any, context: any, options?: any) =>
    runCursorTurn({
      model,
      context,
      options,
      apiKey: resolveCursorApiKey(options?.apiKey, {
        env: process.env.CURSOR_API_KEY,
      }),
      deps,
    });
  return { stream, streamSimple: stream };
}
