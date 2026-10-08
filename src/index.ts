import {
  createAssistantMessageEventStream,
  calculateCost,
  createProvider,
  envApiKeyAuth,
} from "@earendil-works/pi-ai";
import {
  registerApiProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

import {
  CURSOR_PROVIDER_ID,
  CURSOR_BASE_URL,
  CURSOR_COMPAT_SOURCE_ID,
  createCursorCompatApiProvider,
  resolveCursorApiKey,
  discoverCursorModels,
  fallbackModels,
  createCursorStreams,
} from "./cursor-core.js";

function authJsonPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR
    ? join(process.env.PI_CODING_AGENT_DIR, "auth.json")
    : join(homedir(), ".pi", "agent", "auth.json");
  return dir;
}

export function writeCursorKey(key: string): void {
  const path = authJsonPath();
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  data[CURSOR_PROVIDER_ID] = { type: "api_key", key };
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

async function fetchCursorModels(context: any): Promise<any[]> {
  const stored =
    context?.credential?.type === "api_key"
      ? context.credential.key
      : undefined;
  const live = await discoverCursorModels(
    resolveCursorApiKey(stored, { env: process.env.CURSOR_API_KEY }),
  );
  // discoverCursorModels() records the live IDs. The fallback list must not
  // replace them, or cached models such as grok-4.7 would map to default.
  return live.length ? live : fallbackModels();
}

export function createCursorProvider() {
  return createProvider({
    id: CURSOR_PROVIDER_ID,
    name: "Cursor",
    baseUrl: CURSOR_BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("Cursor API key", ["CURSOR_API_KEY"]),
    },
    models: fallbackModels(),
    fetchModels: fetchCursorModels,
    api: createCursorStreams({
      createStream: createAssistantMessageEventStream,
      calculateCost,
    }),
  });
}

export default function (pi: any) {
  const provider = createCursorProvider();
  pi.registerProvider(provider);
  registerApiProvider(
    createCursorCompatApiProvider(provider),
    CURSOR_COMPAT_SOURCE_ID,
  );
  pi.on("session_shutdown", () => {
    unregisterApiProviders(CURSOR_COMPAT_SOURCE_ID);
  });

  pi.registerCommand("cursor-auth", {
    description: "Store your Cursor SDK API key for pi (env, arg, or prompt)",
    handler: async (args: string, ctx: any) => {
      let key = (args || "").trim() || process.env.CURSOR_API_KEY;
      if (!key && ctx?.ui?.input) {
        key = (await ctx.ui.input("Paste your Cursor API key:")).trim();
      }
      if (!key) {
        ctx?.ui?.notify("No Cursor API key provided.", "warning");
        return;
      }
      writeCursorKey(key);
      if (ctx?.modelRegistry?.refresh) {
        await ctx.modelRegistry.refresh({
          providers: [CURSOR_PROVIDER_ID],
          allowNetwork: true,
          force: true,
        });
        ctx?.ui?.notify("Cursor API key saved. Model catalog refreshed.", "info");
        return;
      }
      ctx?.ui?.notify(
        "Cursor API key saved. Run /cursor-refresh-models to load the live catalog.",
        "info",
      );
    },
  });

  pi.registerCommand("cursor-refresh-models", {
    description:
      "Re-discover the live Cursor model catalog with the current key",
    handler: async (_args: string, ctx: any) => {
      if (!ctx?.modelRegistry?.refresh) {
        ctx?.ui?.notify(
          "This pi version cannot refresh provider catalogs.",
          "warning",
        );
        return;
      }
      const result = await ctx.modelRegistry.refresh({
        providers: [CURSOR_PROVIDER_ID],
        allowNetwork: true,
        force: true,
      });
      if (result?.aborted) {
        ctx?.ui?.notify("Cursor catalog refresh was cancelled.", "warning");
        return;
      }
      const refreshError = result?.errors?.get?.(CURSOR_PROVIDER_ID);
      if (refreshError) {
        ctx?.ui?.notify(
          `Cursor catalog refresh failed: ${refreshError.message ?? refreshError}`,
          "warning",
        );
        return;
      }
      const count = (ctx.modelRegistry.getAll?.() ?? []).filter(
        (m: any) => m.provider === CURSOR_PROVIDER_ID,
      ).length;
      ctx?.ui?.notify(`Cursor catalog refreshed with ${count} models.`, "info");
    },
  });
}
