// MCP 2.0 — "core" tools: contacts, tags, notes, custom fields, team and API keys.
// See ../CONVENTIONS.md. Implementations live in ./core/*.
import type { AnyMcpTool } from '../types';
import { contactTools } from './core/contacts';
import { noteTools } from './core/notes';
import { tagTools } from './core/tags';
import { teamTools } from './core/team';

export const coreTools: AnyMcpTool[] = [...teamTools, ...contactTools, ...tagTools, ...noteTools];
