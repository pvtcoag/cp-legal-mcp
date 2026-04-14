import { AsyncLocalStorage } from 'node:async_hooks';

// Propagates per-request context (user identity, session ID) into MCP tool handlers,
// which run inside the transport and have no direct access to the Express request.
export interface RequestContext {
  user: string | undefined;
  /** MCP session ID from the Mcp-Session-Id header. Stable within a conversation. */
  sessionId: string | undefined;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getUser(): string | undefined {
  return requestContext.getStore()?.user;
}

export function getSessionId(): string | undefined {
  return requestContext.getStore()?.sessionId;
}
