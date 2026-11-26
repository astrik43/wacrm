import type { BuilderStepInput } from './steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
  type ValidationIssue,
} from './validate'

// Normalise + validate an automation definition (trigger + step tree)
// coming from a non-UI caller (the MCP tools). It reuses the exact
// validators the dashboard API runs on activation; this module only adds
// the structural checks the UI makes impossible by construction (unknown
// step types, branches on a non-condition step, runaway nesting).

export const AUTOMATION_STEP_TYPES = [
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
  'add_tag',
  'remove_tag',
  'assign_conversation',
  'update_contact_field',
  'create_deal',
  'wait',
  'condition',
  'send_webhook',
  'close_conversation',
] as const

const MAX_DEPTH = 5
const MAX_STEPS = 100

export interface NormalisedStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes: NormalisedStep[]; no: NormalisedStep[] }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Turn loosely-typed input into the builder tree shape, collecting structural issues. */
export function normaliseSteps(
  raw: unknown,
  issues: ValidationIssue[],
): NormalisedStep[] {
  let count = 0
  const walk = (list: unknown, prefix: string, depth: number): NormalisedStep[] => {
    if (!Array.isArray(list)) return []
    const out: NormalisedStep[] = []
    list.forEach((item, i) => {
      const path = `${prefix}steps[${i}]`
      count += 1
      if (count > MAX_STEPS) {
        if (count === MAX_STEPS + 1) {
          issues.push({ path: 'steps', message: `at most ${MAX_STEPS} steps are allowed` })
        }
        return
      }
      if (!isObject(item) || typeof item.step_type !== 'string') {
        issues.push({ path, message: 'each step needs a step_type' })
        return
      }
      if (!(AUTOMATION_STEP_TYPES as readonly string[]).includes(item.step_type)) {
        issues.push({
          path: `${path}.step_type`,
          message: `unknown step type: ${item.step_type}`,
        })
        return
      }
      const step: NormalisedStep = {
        step_type: item.step_type,
        step_config: isObject(item.step_config) ? item.step_config : {},
      }
      // loadStepsTree() emits empty yes/no arrays on every node, so only
      // non-empty branches on a non-condition step are an error.
      const b0 = isObject(item.branches) ? item.branches : {}
      const hasBranchSteps =
        (Array.isArray(b0.yes) && b0.yes.length > 0) || (Array.isArray(b0.no) && b0.no.length > 0)
      if (hasBranchSteps && item.step_type !== 'condition') {
        issues.push({ path: `${path}.branches`, message: 'only condition steps can have branches' })
      }
      if (item.step_type === 'condition') {
        const b = isObject(item.branches) ? item.branches : {}
        if (depth >= MAX_DEPTH) {
          issues.push({ path, message: `conditions can be nested at most ${MAX_DEPTH} levels deep` })
        } else {
          step.branches = {
            yes: walk(b.yes, `${path}.yes.`, depth + 1),
            no: walk(b.no, `${path}.no.`, depth + 1),
          }
        }
      }
      out.push(step)
    })
    return out
  }
  return walk(raw, '', 0)
}

export interface AutomationDefinitionInput {
  trigger_type: string
  trigger_config: Record<string, unknown>
  steps: unknown
}

export interface AutomationDefinitionCheck {
  steps: NormalisedStep[]
  issues: ValidationIssue[]
}

/** Structural normalisation plus the shared activation validators. */
export function checkAutomationDefinition(
  input: AutomationDefinitionInput,
): AutomationDefinitionCheck {
  const issues: ValidationIssue[] = []
  const steps = normaliseSteps(input.steps ?? [], issues)
  issues.push(...validateTriggerForActivation(input.trigger_type, input.trigger_config))
  issues.push(...validateStepsForActivation(steps))
  return { steps, issues }
}

export function asBuilderSteps(steps: NormalisedStep[]): BuilderStepInput[] {
  return steps as unknown as BuilderStepInput[]
}
