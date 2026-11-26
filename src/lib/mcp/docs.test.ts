import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { API_SCOPES } from '@/lib/api-keys/scopes';

import { ALL_TOOLS } from './tools';

// docs/mcp-tools.md and docs/mcp.md are written by hand from the
// registry. These checks fail when a tool or scope is added, renamed or
// removed without the docs being updated.
const read = (f: string) => readFileSync(join(process.cwd(), 'docs', f), 'utf8');

describe('MCP docs', () => {
  const reference = read('mcp-tools.md');
  const guide = read('mcp.md');

  it('documents every tool in the reference, with its tier and scope', () => {
    for (const tool of ALL_TOOLS) {
      const row = reference.split('\n').find((l) => l.startsWith(`| \`${tool.name}\` |`));
      expect(row, `docs/mcp-tools.md has no row for ${tool.name}`).toBeDefined();
      expect(row).toContain(tool.scope ? `\`${tool.scope}\`` : 'any key');
      expect(row).toContain(tool.tier === 'destructive' ? '**destructive**' : `| ${tool.tier} |`);
    }
  });

  it('documents no tool that does not exist', () => {
    const documented = [...reference.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]);
    const real = new Set(ALL_TOOLS.map((t) => t.name));
    expect(documented.filter((n) => !real.has(n))).toEqual([]);
  });

  it('states the real tool count', () => {
    expect(reference).toContain(`All ${ALL_TOOLS.length} tools`);
    expect(guide).toContain(`**${ALL_TOOLS.length}**`);
  });

  it('lists every API scope in the guide', () => {
    for (const scope of API_SCOPES) {
      expect(guide, `docs/mcp.md is missing scope ${scope}`).toContain(`| \`${scope}\` |`);
    }
  });
});
