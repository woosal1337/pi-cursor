import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractLastUserImages,
  buildHarnessPrompt,
  collectToolCalls,
  unwrapCursorToolCall,
  thinkingParams,
  setKnownModelIds,
  runCursorTurn,
  resolveCursorApiKey,
  fallbackModels,
  thinkingLevelMap,
  toPiModel,
  CURSOR_API,
  CURSOR_COMPAT_SOURCE_ID,
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
