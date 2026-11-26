import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALL_TOOLS } from './tools';

// The wacrm Claude plugin (plugin/wacrm). Its skills name MCP tools in
// backticks; this keeps them honest as tools are added, renamed or removed.
const PLUGIN = join(process.cwd(), 'plugin', 'wacrm');
const SKILLS = join(PLUGIN, 'skills');

// Tools that live in the ERP's own MCP server, not in wacrm.
const ERP_TOOLS = new Set(['comment_on_order']);
// Setting / argument names that happen to start with a tool verb.
const NOT_TOOLS = new Set(['sync_tags']);

// A backticked snake_case token that starts with a tool verb is a tool name.
const TOOL_LIKE =
  /^(get|list|search|create|update|delete|send|set|add|remove|apply|find|estimate|export|import|mark|move|reopen|resolve|resume|revoke|rename|reorder|reindex|replay|sync|submit|verify|check|assign|unassign|activate|deactivate|duplicate|cancel|invite|change|run|draft|preview)_[a-z_]+$/;

const toolNames = new Set(ALL_TOOLS.map((t) => t.name));
const skillDirs = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe('wacrm plugin skills', () => {
  it('has the manifest and an MCP connection that uses an env-var key', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe('wacrm');
    const mcp = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.wacrm.type).toBe('http');
    expect(mcp.mcpServers.wacrm.url).toBe('${WACRM_MCP_URL}');
    expect(mcp.mcpServers.wacrm.headers.Authorization).toBe('Bearer ${WACRM_API_KEY}');
  });

  it('lists every skill in the README', () => {
    const readme = readFileSync(join(PLUGIN, 'README.md'), 'utf8');
    for (const dir of skillDirs) expect(readme, `README is missing ${dir}`).toContain(`\`${dir}\``);
  });

  describe.each(skillDirs)('%s', (dir) => {
    const text = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8');

    it('has frontmatter whose name matches the folder', () => {
      const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
      expect(front, 'SKILL.md needs name and description frontmatter').not.toBeNull();
      expect(front![1]).toBe(dir);
      expect(front![2].length).toBeGreaterThan(60);
    });

    it('only names tools that exist', () => {
      const tokens = [...text.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]);
      const missing = tokens.filter(
        (t) => (t === 'whoami' || TOOL_LIKE.test(t)) &&
          !toolNames.has(t) &&
          !ERP_TOOLS.has(t) &&
          !NOT_TOOLS.has(t)
      );
      expect(missing, `unknown tools in ${dir}: ${missing.join(', ')}`).toEqual([]);
    });

    if (dir !== 'wacrm-safety-rules') {
      it('points at the safety rules', () => {
        // The skills that send or change data load the rules first.
        const touches = /send_|apply_tag_changes|create_automation|update_order_update_event|set_shopify_test_mode|submit_template/.test(text);
        if (touches) expect(text).toContain('wacrm-safety-rules');
      });
    }
  });
});
