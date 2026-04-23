import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './logger.js';

// Resolve project root relative to this file. Works for both `src/` (tsx) and
// `dist/` (compiled) — CLAUDE.md and README.md live at the repo root, one level
// up from either.
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), '..');

function readFileSafe(relPath: string): { ok: true; text: string } | { ok: false; error: string } {
  // Try project root first; fall back to one level deeper (handles dist/src nesting).
  const candidates = [
    path.join(projectRoot, relPath),
    path.join(projectRoot, '..', relPath),
  ];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      return { ok: true, text };
    } catch {
      // try next candidate
    }
  }
  const msg = `Unable to read ${relPath} from any of: ${candidates.join(', ')}`;
  logger.warn({ relPath, candidates }, msg);
  return { ok: false, error: msg };
}

// Cache at module load — these files are static relative to the build artefact.
const workflowsGuide = readFileSafe('CLAUDE.md');
const readmeGuide = readFileSafe('README.md');

export function registerResources(server: McpServer): void {
  server.registerResource(
    'workflows-guide',
    'guide://workflows',
    {
      title: 'CP Legal Research — Workflow Guide',
      description:
        'Canonical research workflows, tool selection rules, and anti-patterns for the CP Legal legal research MCP.',
      mimeType: 'text/markdown',
    },
    (uri) => {
      const text = workflowsGuide.ok
        ? workflowsGuide.text
        : `# Workflow guide unavailable\n\nThe server could not locate CLAUDE.md at startup.\n\nDetails: ${workflowsGuide.error}`;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text,
          },
        ],
      };
    },
  );

  server.registerResource(
    'readme',
    'guide://readme',
    {
      title: 'cp-legal-mcp README',
      description:
        'Project README for the CP Legal legal research MCP server (deployment, configuration, tool surface).',
      mimeType: 'text/markdown',
    },
    (uri) => {
      const text = readmeGuide.ok
        ? readmeGuide.text
        : `# README unavailable\n\nThe server could not locate README.md at startup.\n\nDetails: ${readmeGuide.error}`;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text,
          },
        ],
      };
    },
  );
}
