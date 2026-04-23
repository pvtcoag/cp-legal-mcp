import { describe, it, expect } from 'vitest';
import { registerTool } from '../src/tools/_shared.js';

const ADMIN_NOTE = '\n\nIf this error persists, contact your administrator.';

interface Captured {
  name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler?: (input: any, ctx?: any) => Promise<any>;
}

function makeStubServer(): { captured: Captured; server: Parameters<typeof registerTool>[0] } {
  const captured: Captured = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool: (name: string, config: any, handler: any) => {
      captured.name = name;
      captured.config = config;
      captured.handler = handler;
    },
  } as unknown as Parameters<typeof registerTool>[0];
  return { captured, server };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function register(handler: (input: any, ctx?: any) => any): Captured {
  const { captured, server } = makeStubServer();
  registerTool(
    server,
    'test_tool',
    {
      description: 'test',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler,
  );
  return captured;
}

describe('registerTool error decoration', () => {
  it('appends admin note to JSON error "message" field', async () => {
    const captured = register(async () => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ message: 'Upstream timed out', code: 'ETIMEOUT' }) }],
    }));
    const res = await captured.handler!({}, {});
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.message).toBe('Upstream timed out' + ADMIN_NOTE);
    expect(parsed.code).toBe('ETIMEOUT');
  });

  it('appends admin note as suffix to plain string error text', async () => {
    const captured = register(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'something went wrong' }],
    }));
    const res = await captured.handler!({}, {});
    expect(res.content[0].text).toBe('something went wrong' + ADMIN_NOTE);
  });

  it('leaves JSON without a "message" field as-is, appending admin note to raw text', async () => {
    const captured = register(async () => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ err: 'bad' }) }],
    }));
    const res = await captured.handler!({}, {});
    // Since JSON parses but has no "message" field, text path falls through to suffix
    expect(res.content[0].text.endsWith(ADMIN_NOTE)).toBe(true);
  });

  it('passes a non-error response through unchanged', async () => {
    const original = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { foo: 'bar', count: 3 },
    };
    const captured = register(async () => original);
    const res = await captured.handler!({}, {});
    expect(res).toEqual(original);
    expect(res.structuredContent).toEqual({ foo: 'bar', count: 3 });
  });

  it('passes response with isError=false unchanged', async () => {
    const original = { isError: false, content: [{ type: 'text', text: 'fine' }] };
    const captured = register(async () => original);
    const res = await captured.handler!({}, {});
    expect(res).toEqual(original);
  });

  it('forwards tool name and config to the underlying server.registerTool', () => {
    const captured = register(async () => ({ content: [] }));
    expect(captured.name).toBe('test_tool');
    expect(captured.config.description).toBe('test');
    expect(captured.config.annotations).toEqual({ readOnlyHint: true });
  });
});
