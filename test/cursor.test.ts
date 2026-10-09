import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractLastUserImages,
  buildHarnessPrompt,
  resolveTurnContext,
  collectToolCalls,
  unwrapCursorToolCall,
  thinkingParams,
  cursorModelParams,
  defaultContext,
  withFastVariants,
  setKnownModelIds,
  runCursorTurn,
  resolveCursorApiKey,
  fallbackModels,
  thinkingLevelMap,
  toPiModel,
  CURSOR_API,
  CURSOR_COMPAT_SOURCE_ID,
  countModelCalls,
  estimatePromptTokens,
  promptChars,
  readCursorUsageNote,
  createCursorCompatApiProvider,
  configureCursorRipgrepPath,
} from "../src/cursor-core.ts";

function fakeStream() {
  const events: any[] = [];
  let resolveClosed: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  return {
    events,
    closed,
    push: (e: any) => events.push(e),
    end: () => resolveClosed(),
  };
}

test("extractLastUserImages returns images from the last user message", () => {
  const images = extractLastUserImages({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "base64data" },
        ],
      },
    ],
  });
  assert.equal(images?.length, 1);
  assert.equal(images?.[0].data, "base64data");
});

test("extractLastUserImages is undefined for string content", () => {
  const images = extractLastUserImages({
    messages: [{ role: "user", content: "do the thing" }],
  });
  assert.equal(images, undefined);
});

test("buildHarnessPrompt puts pi's system prompt and history in front of Cursor", () => {
  const prompt = buildHarnessPrompt({
    systemPrompt: "Be a lazy senior.",
    messages: [
      { role: "user", content: "read pkg" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          {
            type: "toolCall",
            id: "c1",
            name: "read",
            arguments: { path: "package.json" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "{}" }],
      },
    ],
  });
  assert.match(prompt, /Use only the tools provided/);
  assert.match(prompt, /Be a lazy senior/);
  assert.match(prompt, /\[user\]\nread pkg/);
  assert.match(prompt, /\[tool_call read c1\]/);
  assert.match(prompt, /\[tool_result read c1\]/);
  assert.ok(
    prompt.indexOf("Be a lazy senior") < prompt.indexOf("[user]"),
    "pi system prompt must precede conversation",
  );
});

test("collectToolCalls reads Cursor tool_use blocks", () => {
  const calls = collectToolCalls([
    { type: "text", text: "hi" },
    { type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "c1");
  assert.equal(calls[0].name, "bash");
  assert.equal(calls[0].arguments.command, "ls");
});

test("unwrapCursorToolCall maps MCP calls onto pi tool names", () => {
  const call = unwrapCursorToolCall(
    "CallMcpTool",
    {
      toolName: "read",
      arguments: { path: "package.json" },
    },
    "c1",
    new Set(["read"]),
  );
  assert.equal(call?.name, "read");
  assert.equal(call?.arguments.path, "package.json");
  assert.equal(
    unwrapCursorToolCall("GetMcpTools", {}, "c2", new Set(["read"])),
    null,
  );
  assert.equal(
    unwrapCursorToolCall("shell", { command: "rm -rf /" }, "c3", new Set(["read"])),
    null,
  );
});

test("thinkingParams maps pi reasoning onto Cursor model params", () => {
  const model = {
    cursorParameters: [
      {
        id: "reasoning_effort",
        displayName: "Reasoning",
        values: [{ value: "low" }, { value: "high" }],
      },
    ],
  };
  assert.deepEqual(thinkingParams(model, "high"), [
    { id: "reasoning_effort", value: "high" },
  ]);
  assert.equal(thinkingParams(model, "off"), undefined);
  assert.equal(thinkingParams({}, "high"), undefined);
});

// Parameters as Cursor's catalog lists them for grok-4.7.
const grokParameters = [
  { id: "context", values: [{ value: "256k" }, { value: "500k" }] },
  { id: "reasoning_effort", values: ["low", "medium", "high", "xhigh"].map((value) => ({ value })) },
  { id: "fast", values: [{ value: "false" }, { value: "true" }] },
];

test("cursorModelParams sends fast and the smallest context every time", () => {
  const grok = toPiModel({ id: "grok-4.7", displayName: "Grok 4.7", parameters: grokParameters });
  assert.deepEqual(cursorModelParams(grok, "xhigh"), [
    { id: "reasoning_effort", value: "xhigh" },
    { id: "fast", value: "false" },
    { id: "context", value: "256k" },
  ]);
  assert.deepEqual(cursorModelParams({ ...grok, cursorFast: true }, undefined), [
    { id: "fast", value: "true" },
    { id: "context", value: "256k" },
  ]);
  // A model without fast or context options gets neither.
  assert.equal(cursorModelParams({ cursorParameters: [] }, "high"), undefined);
});

test("toPiModel sets the context window from the smallest Cursor context", () => {
  const window = (values: string[]) =>
    toPiModel({ id: "m", parameters: [{ id: "context", values: values.map((value) => ({ value })) }] })
      .contextWindow;
  assert.equal(window(["256k", "500k"]), 256000);
  assert.equal(window(["1m", "300k"]), 300000);
  assert.equal(window(["272k", "1m"]), 272000);
  assert.equal(toPiModel({ id: "default" }).contextWindow, 200000);
  assert.deepEqual(defaultContext([{ id: "context", values: [{ value: "1m" }] }]), {
    value: "1m",
    tokens: 1000000,
  });
});

test("withFastVariants adds a -fast copy of each model that offers Fast", () => {
  const grok = toPiModel({ id: "grok-4.7", displayName: "Grok 4.7", parameters: grokParameters });
  const plain = toPiModel({ id: "claude-sonnet-4", displayName: "Claude Sonnet 4" });
  const models = withFastVariants([grok, plain]);
  assert.deepEqual(models.map((m) => m.id), ["grok-4.7", "grok-4.7-fast", "claude-sonnet-4"]);
  const fast = models[1];
  assert.equal(fast.name, "Grok 4.7 Fast");
  assert.equal(fast.cursorModelId, "grok-4.7");
  assert.equal(fast.cursorFast, true);
  assert.deepEqual(fast.thinkingLevelMap, grok.thinkingLevelMap);
  assert.equal(fast.contextWindow, 256000);
});

test("runCursorTurn sends a -fast copy as its Cursor model with fast on", async () => {
  setKnownModelIds(["grok-4.7"]);
  const stream = fakeStream();
  let created: any;
  const createAgent = async (opts: any) => {
    created = opts;
    return {
      send: async () => ({
        stream: async function* () {},
        cancel: async () => {},
        wait: async () => ({ status: "finished" }),
      }),
      close: () => {},
    };
  };
  const grok = toPiModel({ id: "grok-4.7", displayName: "Grok 4.7", parameters: grokParameters });
  const [, fast] = withFastVariants([grok]);
  runCursorTurn({
    model: fast,
    context: { messages: [{ role: "user", content: "hi" }] },
    options: { reasoning: "high" },
    apiKey: "test-key",
    deps: { createStream: () => stream, calculateCost: () => {}, createAgent },
  });
  await stream.closed;
  assert.deepEqual(created.model, {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
      { id: "context", value: "256k" },
    ],
  });
});

test("cursor streams expose a pi-ai compat registration", () => {
  const stream = () => "stream";
  const registration = createCursorCompatApiProvider({
    stream,
    streamSimple: stream,
  });

  assert.equal(CURSOR_COMPAT_SOURCE_ID, "pi-cursor-auth");
  assert.equal(registration.api, CURSOR_API);
  assert.equal(registration.stream, stream);
  assert.equal(registration.streamSimple, stream);
});

test("fallbackModels are complete pi Model objects", () => {
  const models = fallbackModels();
  assert.ok(models.length > 0);
  for (const model of models) {
    assert.equal(model.provider, "cursor");
    assert.equal(model.api, "cursor-sdk");
    assert.equal(model.baseUrl, "https://cursor.com");
    assert.equal(typeof model.id, "string");
    assert.equal(model.reasoning, true);
  }
});

test("configureCursorRipgrepPath preserves an explicit SDK path", () => {
  const env = { CURSOR_RIPGREP_PATH: "/tmp/rg" };
  assert.equal(configureCursorRipgrepPath(env), "/tmp/rg");
  assert.equal(env.CURSOR_RIPGREP_PATH, "/tmp/rg");
});

test("resolveCursorApiKey prefers explicit key over placeholder/env/stored", () => {
  assert.equal(
    resolveCursorApiKey("real-key", { env: "env-key", stored: "stored-key" }),
    "real-key",
  );
  assert.equal(
    resolveCursorApiKey("pi-cursor-auth-placeholder", {
      env: "env-key",
      stored: "stored-key",
    }),
    "env-key",
  );
  assert.equal(
    resolveCursorApiKey(undefined, { stored: "stored-key" }),
    "stored-key",
  );
  assert.equal(
    resolveCursorApiKey(undefined, { env: "", stored: "" }),
    undefined,
  );
});

test("thinkingLevelMap declares xhigh and max only when Cursor offers them", () => {
  const effort = (...values: string[]) => [
    {
      id: "reasoning_effort",
      displayName: "Effort",
      values: values.map((value) => ({ value })),
    },
    {
      id: "fast",
      displayName: "Fast",
      values: [{ value: "false" }, { value: "true" }],
    },
  ];

  assert.deepEqual(thinkingLevelMap(effort("low", "medium", "high", "xhigh")), {
    xhigh: "xhigh",
  });
  assert.deepEqual(thinkingLevelMap(effort("low", "high", "xhigh", "max")), {
    xhigh: "xhigh",
    max: "max",
  });
  assert.equal(thinkingLevelMap(effort("low", "medium", "high")), undefined);
  assert.equal(
    thinkingLevelMap([{ id: "fast", values: [{ value: "true" }] }]),
    undefined,
  );
  assert.equal(thinkingLevelMap(undefined), undefined);
});

test("toPiModel exposes Cursor's extended effort levels to pi", () => {
  const grok = toPiModel({
    id: "grok-4.7",
    displayName: "Grok 4.7",
    parameters: [
      {
        id: "reasoning_effort",
        displayName: "Effort",
        values: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
        ],
      },
    ],
  });
  assert.deepEqual(grok.thinkingLevelMap, { xhigh: "xhigh" });
  assert.deepEqual(thinkingParams(grok, "xhigh"), [
    { id: "reasoning_effort", value: "xhigh" },
  ]);

  const plain = toPiModel({ id: "default", displayName: "Cursor Default" });
  assert.equal("thinkingLevelMap" in plain, false);
});

test("runCursorTurn errors without an API key", async () => {
  setKnownModelIds(["default"]);
  const stream = fakeStream();
  runCursorTurn({
    model: { id: "default", api: "cursor-sdk", provider: "cursor" },
    context: { messages: [{ role: "user", content: "hi" }] },
    apiKey: undefined,
    deps: { createStream: () => stream, calculateCost: () => {} },
  });
  await stream.closed;
  const error = stream.events.find((e) => e.type === "error");
  assert.ok(error, "expected an error event");
  assert.match(error.error.errorMessage, /No Cursor API key/);
});

test("runCursorTurn maps unknown model id to default", async () => {
  setKnownModelIds(["default", "claude-opus-5"]);
  const stream = fakeStream();
  runCursorTurn({
    model: { id: "auto-smart", api: "cursor-sdk", provider: "cursor" },
    context: { messages: [{ role: "user", content: "hi" }] },
    apiKey: undefined,
    deps: { createStream: () => stream, calculateCost: () => {} },
  });
  await stream.closed;
  const error = stream.events.find((e) => e.type === "error");
  assert.match(error.error.errorMessage, /No Cursor API key/);
});

test("runCursorTurn keeps a cached model id until the live catalog loads", async () => {
  const sentModelId = async (id: string) => {
    const stream = fakeStream();
    let created: any;
    const createAgent = async (opts: any) => {
      created = opts;
      return {
        send: async () => ({
          stream: async function* () {},
          cancel: async () => {},
          wait: async () => ({ status: "finished" }),
        }),
        close: () => {},
      };
    };
    runCursorTurn({
      model: { id, api: "cursor-sdk", provider: "cursor" },
      context: { messages: [{ role: "user", content: "hi" }] },
      apiKey: "test-key",
      deps: { createStream: () => stream, calculateCost: () => {}, createAgent },
    });
    await stream.closed;
    return created.model.id;
  };

  // pi print mode loads models from its cache and never fetches the live catalog.
  setKnownModelIds([]);
  assert.equal(await sentModelId("grok-4.7"), "grok-4.7");
  assert.equal(await sentModelId("auto"), "default");

  setKnownModelIds(["grok-4.7"]);
  assert.equal(await sentModelId("grok-4.7"), "grok-4.7");
  assert.equal(await sentModelId("not-a-cursor-model"), "default");
});

test("runCursorTurn emits pi toolCall events and does not enable Cursor tools", async () => {
  setKnownModelIds(["default"]);
  const stream = fakeStream();
  let created: any;
  const createAgent = async (opts: any) => {
    created = opts;
    return {
      send: async () => ({
        stream: async function* () {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Reading package.json now." }],
            },
          };
          yield {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "c1",
                  name: "read",
                  input: { path: "package.json" },
                },
              ],
            },
          };
        },
        cancel: async () => {},
        wait: async () => ({ status: "cancelled" }),
      }),
      close: () => {},
    };
  };

  runCursorTurn({
    model: { id: "default", api: "cursor-sdk", provider: "cursor" },
    context: {
      systemPrompt: "Use pi tools.",
      messages: [{ role: "user", content: "read package.json" }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    },
    apiKey: "test-key",
    deps: {
      createStream: () => stream,
      calculateCost: () => {},
      createAgent,
    },
  });
  await stream.closed;

  assert.deepEqual(created.tools, ["mcp"]);
  assert.equal(typeof created.local.customTools.read.execute, "function");
  assert.deepEqual(created.local.settingSources, []);

  const error = stream.events.find((e) => e.type === "error");
  assert.ok(!error, `unexpected error: ${error?.error?.errorMessage}`);
  const done = stream.events.find((e) => e.type === "done");
  assert.equal(done.reason, "toolUse");
  const toolCalls = done.message.content.filter((c: any) => c.type === "toolCall");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "read");
  assert.equal(toolCalls[0].arguments.path, "package.json");
  assert.ok(
    stream.events.some((e) => e.type === "toolcall_end"),
    "expected toolcall_end",
  );
});

test("runCursorTurn unwraps Cursor MCP tool calls into pi tool names", async () => {
  setKnownModelIds(["default"]);
  const stream = fakeStream();
  const createAgent = async () => ({
    send: async () => ({
      stream: async function* () {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "c1",
                name: "CallMcpTool",
                input: {
                  toolName: "read",
                  arguments: { path: "package.json" },
                },
              },
            ],
          },
        };
      },
      cancel: async () => {},
      wait: async () => ({ status: "cancelled" }),
    }),
    close: () => {},
  });

  runCursorTurn({
    model: { id: "default", api: "cursor-sdk", provider: "cursor" },
    context: {
      systemPrompt: "Use pi tools.",
      messages: [{ role: "user", content: "read package.json" }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    },
    apiKey: "test-key",
    deps: {
      createStream: () => stream,
      calculateCost: () => {},
      createAgent,
    },
  });
  await stream.closed;

  const done = stream.events.find((e) => e.type === "done");
  assert.equal(done.reason, "toolUse");
  const toolCalls = done.message.content.filter((c: any) => c.type === "toolCall");
  assert.equal(toolCalls[0].name, "read");
  assert.equal(toolCalls[0].arguments.path, "package.json");
});

// A fake Cursor agent. The run sends onDelta updates, then streams messages.
function fakeCursorAgent(run: {
  thinkingBlocks?: number;
  messages?: any[];
  usage?: any;
  status?: string;
}) {
  let created: any;
  const createAgent = async (opts: any) => {
    created = opts;
    return {
      send: async (_message: any, sendOptions: any) => {
        for (let i = 0; i < (run.thinkingBlocks ?? 0); i++) {
          sendOptions?.onDelta?.({ update: { type: "thinking-completed" } });
        }
        if (run.usage) {
          sendOptions?.onDelta?.({ update: { type: "turn-ended", usage: run.usage } });
        }
        return {
          stream: async function* () {
            for (const message of run.messages ?? []) yield message;
            if (run.usage) yield { type: "usage", usage: run.usage };
          },
          cancel: async () => {},
          wait: async () => ({ status: run.status ?? "finished", usage: run.usage }),
        };
      },
      close: () => {},
    };
  };
  return { createAgent, created: () => created };
}

async function runTurn(model: any, context: any, agent: { createAgent: any }) {
  const stream = fakeStream();
  runCursorTurn({
    model,
    context,
    apiKey: "test-key",
    deps: { createStream: () => stream, calculateCost: () => {}, createAgent: agent.createAgent },
  });
  await stream.closed;
  return stream.events.find((e) => e.type === "done");
}

const grok = { id: "grok-4.7", api: "cursor-sdk", provider: "cursor", contextWindow: 256000 };

test("runCursorTurn counts Cursor's cached input tokens once", async () => {
  setKnownModelIds(["default"]);
  // Cursor's inputTokens include cacheReadTokens, and its totalTokens counts them twice.
  const usage = {
    inputTokens: 4635,
    outputTokens: 630,
    cacheReadTokens: 2560,
    cacheWriteTokens: 0,
    totalTokens: 7825,
  };
  const agent = fakeCursorAgent({
    thinkingBlocks: 1,
    usage,
    messages: [{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }],
  });
  const done = await runTurn(
    { id: "default", api: "cursor-sdk", provider: "cursor" },
    { messages: [{ role: "user", content: "hi" }] },
    agent,
  );

  assert.equal(done.reason, "stop");
  assert.equal(done.message.usage.input, 2075);
  assert.equal(done.message.usage.cacheRead, 2560);
  assert.equal(done.message.usage.output, 630);
  assert.equal(done.message.usage.totalTokens, 5265);
  const note = readCursorUsageNote(done.message);
  assert.equal(note?.source, "measured");
  assert.equal(note?.modelCalls, 1);
  assert.equal(note?.promptTokens, 4635);
  assert.equal(note?.model, "default");
});

test("runCursorTurn divides Cursor's summed usage by the model calls", async () => {
  setKnownModelIds(["grok-4.7"]);
  // Usage of the 304k turn in a real chat: two calls of about 151,000 tokens.
  const usage = {
    inputTokens: 301999,
    outputTokens: 2373,
    cacheReadTokens: 152704,
    cacheWriteTokens: 0,
    reasoningTokens: 1000,
  };
  const agent = fakeCursorAgent({
    thinkingBlocks: 2,
    usage,
    messages: [{ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }],
  });
  const done = await runTurn(
    grok,
    { systemPrompt: "x".repeat(510000), messages: [{ role: "user", content: "go" }] },
    agent,
  );

  assert.equal(done.reason, "stop");
  assert.equal(done.message.usage.input, 74648);
  assert.equal(done.message.usage.cacheRead, 76352);
  assert.equal(done.message.usage.output, 1187);
  assert.equal(done.message.usage.reasoning, 500);
  assert.equal(done.message.usage.totalTokens, 152187);
  const note = readCursorUsageNote(done.message);
  assert.equal(note?.modelCalls, 2);
  assert.equal(note?.promptTokens, 151000);
  assert.equal(note?.reported?.inputTokens, 301999);
});

test("countModelCalls trusts Grok's thinking count and fits other models to the estimate", () => {
  // Grok and Composer finish one thinking block for each call.
  assert.equal(countModelCalls(301999, 150000, 2, 256000), 2);
  assert.equal(countModelCalls(150000, 90000, 1, 256000), 1);
  // GPT finished one thinking block for three calls.
  assert.equal(countModelCalls(25230, 8400, 1, 256000), 3);
  // Claude finished no thinking blocks.
  assert.equal(countModelCalls(34419, 11400, 0, 256000), 3);
  assert.equal(countModelCalls(11314, 11400, 0, 256000), 1);
  // One call cannot be larger than the context window.
  assert.equal(countModelCalls(600000, 0, 0, 256000), 3);
});

const noteMessage = (model: string, charsPerToken: number, extra: any = {}) => ({
  role: "assistant",
  stopReason: "toolUse",
  content: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  diagnostics: [
    {
      type: "cursor_usage",
      timestamp: 0,
      details: { source: "measured", model, promptChars: 1, promptTokens: 1, charsPerToken },
    },
  ],
  ...extra,
});

test("estimatePromptTokens uses the newest usage note of the same Cursor model", () => {
  const context = {
    messages: [
      { role: "user", content: "u" },
      noteMessage("grok-4.7", 3.0),
      noteMessage("composer-2.5", 4.5),
      noteMessage("grok-4.7", 2.6, { stopReason: "aborted" }),
    ],
  };
  // 4,000 for Cursor's own prompt, then 300,000 characters at 3 per token.
  assert.deepEqual(estimatePromptTokens(context, 300000, "grok-4.7"), {
    tokens: 104000,
    charsPerToken: 3.0,
  });
  assert.equal(estimatePromptTokens(context, 300000, "grok-4.7", 2).tokens, 106400);
  // Another model uses another tokenizer, so it starts from 3.5.
  assert.equal(estimatePromptTokens(context, 300000, "gpt-5.5").charsPerToken, 3.5);

  // Usage from before this fix has no note. Its summed values are not used.
  const legacy = {
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [],
        usage: { input: 149295, output: 2373, cacheRead: 152704, cacheWrite: 0, totalTokens: 304372 },
      },
    ],
  };
  assert.equal(estimatePromptTokens(legacy, 350000, "grok-4.7").tokens, 104000);
});

test("a measured turn sets the characters per token for the chat", async () => {
  setKnownModelIds(["grok-4.7"]);
  const context = { systemPrompt: "y".repeat(300000), messages: [{ role: "user", content: "go" }] };
  const chars = promptChars(resolveTurnContext(context), buildHarnessPrompt(resolveTurnContext(context)));
  const agent = fakeCursorAgent({
    thinkingBlocks: 1,
    usage: { inputTokens: 104000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    messages: [{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }],
  });
  const done = await runTurn(grok, context, agent);
  const note = readCursorUsageNote(done.message);
  assert.equal(note?.source, "measured");
  assert.equal(note?.promptChars, chars);
  assert.equal(note?.charsPerToken, chars / 100000);
});

test("runCursorTurn estimates a turn that hands a tool call to pi", async () => {
  setKnownModelIds(["grok-4.7"]);
  const context = {
    systemPrompt: "Use pi tools.",
    messages: [
      { role: "user", content: "read package.json" },
      noteMessage("grok-4.7", 3.0, {
        content: [{ type: "thinking", thinking: "t".repeat(90000) }, { type: "text", text: "Reading." }],
      }),
      { role: "user", content: "and again" },
    ],
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  };
  const agent = fakeCursorAgent({
    status: "cancelled",
    messages: [
      { type: "thinking", text: "z".repeat(9000) },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "c1", name: "read", input: { path: "package.json" } }],
        },
      },
    ],
  });
  const done = await runTurn(grok, context, agent);

  assert.equal(done.reason, "toolUse");
  const turn = resolveTurnContext(context);
  const expected = estimatePromptTokens(context, promptChars(turn, buildHarnessPrompt(turn)), "grok-4.7");
  assert.equal(expected.charsPerToken, 3.0);
  // The 90,000 characters of earlier thinking are not in the prompt, so they add nothing.
  assert.ok(expected.tokens < 4300, `estimate ${expected.tokens}`);
  assert.equal(done.message.usage.input, expected.tokens);
  // The output counts the tool call, not the 9,000 characters of thinking.
  assert.ok(done.message.usage.output > 0 && done.message.usage.output < 30);
  assert.equal(
    done.message.usage.totalTokens,
    done.message.usage.input + done.message.usage.output,
  );
  const note = readCursorUsageNote(done.message);
  assert.equal(note?.source, "estimated");
  assert.equal(note?.promptTokens, expected.tokens);
});

test("runCursorTurn disables Cursor tools when pi has none", async () => {
  setKnownModelIds(["default"]);
  const stream = fakeStream();
  let created: any;
  const createAgent = async (opts: any) => {
    created = opts;
    return {
      send: async () => ({
        stream: async function* () {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Sunny and calm today." }] },
          };
        },
        cancel: async () => {},
        wait: async () => ({
          status: "finished",
          usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
        }),
      }),
      close: () => {},
    };
  };

  runCursorTurn({
    model: { id: "default", api: "cursor-sdk", provider: "cursor" },
    context: { messages: [{ role: "user", content: "weather?" }] },
    apiKey: "test-key",
    deps: {
      createStream: () => stream,
      calculateCost: () => {},
      createAgent,
    },
  });
  await stream.closed;

  assert.deepEqual(created.tools, []);
  assert.equal(created.local.customTools, undefined);
  const done = stream.events.find((e) => e.type === "done");
  assert.equal(done.reason, "stop");
  assert.equal(done.message.content[0].text, "Sunny and calm today.");
});

// pi 0.86+ sends the prompt and tools as transcript system messages.
const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const transcriptContext = {
  messages: [
    { role: "system", content: "Use pi tools.", toolsAdded: [readTool], timestamp: 0 },
    { role: "user", content: "read package.json" },
  ],
};
const transcriptHelpers = {
  getCurrentSystemPrompt: (messages: any[]) =>
    messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n"),
  getCurrentTools: (messages: any[]) =>
    messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : [])),
};

test("resolveTurnContext reads the prompt and tools from a pi transcript", () => {
  const turn = resolveTurnContext(transcriptContext, transcriptHelpers);
  assert.equal(turn.systemPrompt, "Use pi tools.");
  assert.deepEqual(turn.tools.map((t) => t.name), ["read"]);
  assert.equal(turn.messages, transcriptContext.messages);

  const legacy = resolveTurnContext(
    { systemPrompt: "Legacy.", tools: [readTool], messages: [] },
    transcriptHelpers,
  );
  assert.equal(legacy.systemPrompt, "Legacy.");
  assert.deepEqual(legacy.tools, [readTool]);

  const bare = resolveTurnContext(transcriptContext);
  assert.equal(bare.systemPrompt, "");
  assert.deepEqual(bare.tools, []);
});

test("runCursorTurn gives Cursor the tools from a pi transcript", async () => {
  setKnownModelIds(["default"]);
  const stream = fakeStream();
  let created: any;
  let sent: any;
  const createAgent = async (opts: any) => {
    created = opts;
    return {
      send: async (message: any) => {
        sent = message;
        return {
          stream: async function* () {
            yield {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "c1",
                    name: "read",
                    input: { path: "package.json" },
                  },
                ],
              },
            };
          },
          cancel: async () => {},
          wait: async () => ({ status: "cancelled" }),
        };
      },
      close: () => {},
    };
  };

  runCursorTurn({
    model: { id: "default", api: "cursor-sdk", provider: "cursor" },
    context: transcriptContext,
    apiKey: "test-key",
    deps: {
      createStream: () => stream,
      calculateCost: () => {},
      createAgent,
      ...transcriptHelpers,
    },
  });
  await stream.closed;

  assert.deepEqual(created.tools, ["mcp"]);
  assert.equal(typeof created.local.customTools.read.execute, "function");
  assert.match(sent, /Use pi tools\./);
  const done = stream.events.find((e) => e.type === "done");
  assert.equal(done.reason, "toolUse");
  const toolCalls = done.message.content.filter((c: any) => c.type === "toolCall");
  assert.equal(toolCalls[0].name, "read");
});

test("runCursorTurn consumes rejected SDK cancellation promises", async () => {
  setKnownModelIds(["default"]);
  const stream = fakeStream();
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  const createAgent = async () => ({
    send: async () => ({
      stream: async function* () {},
      cancel: () => {
        cancelled = true;
        return Promise.reject(new DOMException("This operation was aborted", "AbortError"));
      },
      wait: async () => ({ status: "cancelled" }),
    }),
    close: () => {},
  });

  runCursorTurn({
    model: { id: "default", api: "cursor-sdk", provider: "cursor" },
    context: { messages: [{ role: "user", content: "hi" }] },
    options: { signal: controller.signal },
    apiKey: "test-key",
    deps: { createStream: () => stream, calculateCost: () => {}, createAgent },
  });
  await stream.closed;

  assert.equal(cancelled, true);
  assert.equal(stream.events.find((e) => e.type === "error")?.reason, "aborted");
});

test("runCursorTurn streams a real Cursor response into ONE text block with spaces", {
  skip: !process.env.CURSOR_API_KEY,
  timeout: 180_000,
}, async () => {
  setKnownModelIds(["default"]);
  const stream = fakeStream();
  runCursorTurn({
    model: {
      id: "default",
      api: "cursor-sdk",
      provider: "cursor",
      maxTokens: 64000,
    },
    context: {
      messages: [
        {
          role: "user",
          content:
            "Write a single sentence of at least six words about the weather.",
        },
      ],
    },
    apiKey: process.env.CURSOR_API_KEY,
    deps: { createStream: () => stream, calculateCost: () => {} },
  });
  await stream.closed;

  const error = stream.events.find((e) => e.type === "error");
  assert.ok(!error, `unexpected error: ${error?.error?.errorMessage}`);

  const startCount = stream.events.filter(
    (e) => e.type === "text_start",
  ).length;
  const endCount = stream.events.filter((e) => e.type === "text_end").length;
  assert.equal(
    startCount,
    1,
    "expected exactly one text block start (not per-word)",
  );
  assert.equal(
    endCount,
    1,
    "expected exactly one text block end (not per-word)",
  );

  const done = stream.events.find((e) => e.type === "done");
  assert.ok(done, "expected done event");
  const textBlocks = done.message.content.filter((c: any) => c.type === "text");
  assert.equal(
    textBlocks.length,
    1,
    "expected a single accumulated text block",
  );
  assert.ok(
    textBlocks[0].text.includes(" "),
    "expected words joined with spaces",
  );
  assert.ok(
    done.message.usage.totalTokens > 0,
    "expected non-zero token usage",
  );
});
