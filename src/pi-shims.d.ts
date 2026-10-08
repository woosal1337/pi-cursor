// Minimal ambient declarations for pi's runtime-injected modules.
// pi provides the real implementations at runtime; these only satisfy tsc.
declare module "@earendil-works/pi-ai" {
  export type Api = string;
  export interface AssistantMessage {
    role: string;
    content: any[];
    api: any;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    stopReason: string;
    timestamp: number;
    errorMessage?: string;
  }
  export interface AssistantMessageEventStream {
    push(event: any): void;
    end(message?: any): void;
  }
  export type Context = any;
  export type Model<T = any> = any;
  export type SimpleStreamOptions = any;
  export type StopReason = string;
  export type Provider = any;
  export function createAssistantMessageEventStream(): AssistantMessageEventStream;
  export function calculateCost(model: any, usage: any): void;
  export function createProvider(input: any): Provider;
  export function envApiKeyAuth(
    name: string,
    envVars: readonly string[],
  ): any;
  export function getCurrentSystemPrompt(messages: readonly any[]): string;
  export function getCurrentTools(messages: readonly any[]): any[];
}

declare module "@earendil-works/pi-ai/compat" {
  export function registerApiProvider(provider: any, sourceId?: string): void;
  export function unregisterApiProviders(sourceId: string): void;
}

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerProvider(providerOrName: any, config?: any): void;
    unregisterProvider(id: string): void;
    registerCommand(name: string, options: any): void;
    on(
      event: string,
      callback: (event: any, ctx: any) => void | Promise<void>,
    ): void;
  }
  export function readStoredCredential(
    provider: string,
  ): { type?: string; key?: string } | undefined;
  export const CONFIG_DIR_NAME: string;
}
