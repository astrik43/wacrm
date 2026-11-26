// ============================================================
// The tool registry. One array, assembled from the domain files.
// Each domain file belongs to one workstream, so adding tools never
// touches this file or anyone else's.
// ============================================================

import { hasScope } from '@/lib/api-keys/scopes';

import type { AnyMcpTool } from '../types';
import { aiTools } from './ai';
import { automationsTools } from './automations';
import { broadcastsTools } from './broadcasts';
import { commerceTools } from './commerce';
import { coreTools } from './core';
import { flowsTools } from './flows';
import { foundationTools } from './foundation';
import { inboxTools } from './inbox';
import { opsTools } from './ops';
import { pipelineTools } from './pipeline';
import { reportsTools } from './reports';
import { settingsTools } from './settings';
import { templatesTools } from './templates';

const DOMAIN_TOOLS: AnyMcpTool[] = [
  ...coreTools,
  ...inboxTools,
  ...templatesTools,
  ...broadcastsTools,
  ...pipelineTools,
  ...automationsTools,
  ...flowsTools,
  ...aiTools,
  ...settingsTools,
  ...commerceTools,
  ...reportsTools,
  ...opsTools,
];

function countVisible(scopes: readonly string[]): number {
  return ALL_TOOLS.filter((t) => t.scope === null || hasScope(scopes, t.scope)).length;
}

export const ALL_TOOLS: AnyMcpTool[] = [...foundationTools(countVisible), ...DOMAIN_TOOLS];
