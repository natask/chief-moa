export type JsonObject = Record<string, unknown>;
export interface ClientOptions {
  baseUrl?: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface Mutation {
  idempotency_key: string;
  expected_intent_version: number;
  [key: string]: unknown;
}
export interface ProductRevision {
  product_id: string;
  revision: string;
  locator: string;
  digest: `sha256:${string}`;
  media_type?: string;
  provenance: JsonObject;
}
export declare class IntentLauncherError extends Error {
  code: string;
  status?: number;
  details?: unknown;
  requestId?: string;
  toJSON(): JsonObject;
}
export declare function stableIdempotencyKey(operation: string, input: unknown): string;
export declare function decodeProductRef(ref: string): (ProductRevision & { artifact_ref: string }) | null;
export declare const schemas: Readonly<Record<string, JsonObject>>;
export declare class IntentLauncherClient {
  constructor(options: ClientOptions);
  request(method: string, pathname: string, body?: unknown): Promise<any>;
  createMessage(input: JsonObject): Promise<any>;
  createIntent(input: JsonObject): Promise<any>;
  searchIntents(filters?: JsonObject): Promise<any>;
  getIntent(intentId: string): Promise<any>;
  updateIntent(intentId: string, input: Mutation): Promise<any>;
  forkIntent(parentIntentId: string, input: JsonObject): Promise<any>;
  relateIntents(sourceIntentId: string, input: Mutation): Promise<any>;
  searchAgents(filters?: JsonObject): Promise<any>;
  getAgent(agentId: string, filters?: JsonObject): Promise<any>;
  searchRuns(filters?: JsonObject): Promise<any>;
  getRun(runId: string, filters?: JsonObject): Promise<any>;
  claimWork(intentId: string, input: Mutation & { agent_id: string; run_id: string }): Promise<any>;
  releaseWork(intentId: string, input: Mutation): Promise<any>;
  reportProgress(intentId: string, input: Mutation & { agent_id: string; run_id: string }): Promise<any>;
  proposeCompletion(intentId: string, input: Mutation & { agent_id: string; run_id: string; evidence_refs: string[] }): Promise<any>;
  attachProduct(intentId: string, input: Mutation & { agent_id: string; run_id: string; product: ProductRevision }): Promise<any>;
  searchProducts(filters?: JsonObject): Promise<any>;
  getProduct(productId: string, revision: string, filters?: JsonObject): Promise<any>;
  createAttentionItem(intentId: string, input: { idempotency_key: string; message: string; run_id?: string }): Promise<any>;
  searchAttentionItems(filters?: JsonObject): Promise<any>;
  getAttentionItem(notificationId: string, filters?: JsonObject): Promise<any>;
  readStatus(filters?: JsonObject): Promise<any>;
}
