import { and, desc, eq, gte, inArray, isNull, lt, sql } from "@/storage/db"
import { Database } from "@/storage/db"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { AegisEventTable, AegisRuleTable, AegisSessionTable } from "./aegis.sql"
import { Log } from "@/util/log"
import z from "zod"
import path from "path"
import { git } from "@/util/git"
import { MessageV2 } from "@/session/message-v2"
import { InstructionPrompt } from "@/session/instruction"
import { ulid } from "ulid"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { SystemPrompt } from "@/session/system"
import { ProviderTransform } from "@/provider/transform"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SessionTable } from "@/session/session.sql"

export namespace Aegis {
  const log = Log.create({ service: "aegis" })

  export const RuleScope = z.enum(["global", "project"]).meta({
    ref: "AegisRuleScope",
  })
  export type RuleScope = z.infer<typeof RuleScope>

  export const RuleKind = z.enum(["mined", "explicit", "runtime"]).meta({
    ref: "AegisRuleKind",
  })
  export type RuleKind = z.infer<typeof RuleKind>

  export const RuleSeverity = z.enum(["low", "medium", "high"]).meta({
    ref: "AegisRuleSeverity",
  })
  export type RuleSeverity = z.infer<typeof RuleSeverity>

  const Policy = z
    .object({
      intent: z.enum(["default_stack"]),
      target: z.string(),
      condition: z.enum(["if_no_stack_specified"]).optional(),
    })
    .meta({
      ref: "AegisPolicy",
    })
  type Policy = z.infer<typeof Policy>

  export const Matcher = z
    .object({
      tool: z.string().optional(),
      pattern: z.string().optional(),
      not_pattern: z.string().optional(),
      policy: Policy.optional(),
    })
    .meta({
      ref: "AegisMatcher",
    })
  export type Matcher = z.infer<typeof Matcher>

  export const RuleSource = z
    .object({
      type: z.enum(["instruction", "package", "history", "override", "feedback", "runtime", "memory"]),
      value: z.string(),
    })
    .meta({
      ref: "AegisRuleSource",
    })
  export type RuleSource = z.infer<typeof RuleSource>

  export const Rule = z
    .object({
      id: z.string(),
      scope: RuleScope,
      project_id: z.string().optional(),
      kind: RuleKind,
      statement: z.string(),
      matcher: Matcher,
      severity: RuleSeverity,
      confidence: z.number(),
      source: RuleSource.optional(),
      active: z.boolean(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({
      ref: "AegisRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const EventType = z
    .enum([
      "observe",
      "observe_tool_call",
      "observe_tool_result",
      "observe_text",
      "observe_patch",
      "check_started",
      "check_completed",
      "violation",
      "intervention",
      "intervention_injected",
      "issue_unresolved",
      "issue_resolved",
      "escalation",
      "override",
      "feedback",
      "rule_updated",
      "rule_deleted",
      "bootstrap",
      "memory",
    ])
    .meta({
      ref: "AegisEventType",
    })
  export type EventType = z.infer<typeof EventType>

  export const EventInfo = z
    .object({
      id: z.string(),
      session_id: z.string(),
      message_id: z.string().optional(),
      part_id: z.string().optional(),
      rule_id: z.string().optional(),
      type: EventType,
      payload: z.record(z.string(), z.unknown()),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({
      ref: "AegisEvent",
    })
  export type EventInfo = z.infer<typeof EventInfo>

  export const SessionState = z
    .object({
      session_id: z.string(),
      mode: z.enum(["advisory"]).default("advisory"),
      status: z.enum(["running", "paused"]).default("running"),
      queue: z.number(),
      checks: z.number().default(0),
      unresolved: z.number().default(0),
      model: z.string().optional(),
      tokens: z
        .object({
          input: z.number().default(0),
          output: z.number().default(0),
        })
        .default({ input: 0, output: 0 }),
      interventions: z.number(),
      rules: z.object({
        global: z.number(),
        project: z.number(),
        active: z.number(),
      }),
      mining: z.object({
        status: z.enum(["idle", "running", "done"]),
        last_run: z.number().optional(),
      }),
      last_violation: z
        .object({
          rule_id: z.string().optional(),
          statement: z.string(),
          severity: RuleSeverity,
          time: z.number(),
          source: z.enum(["deterministic", "supervisor"]),
          kind: z.string(),
        })
        .optional(),
      last_intervention: z
        .object({
          rule_id: z.string().optional(),
          fingerprint: z.string(),
          severity: RuleSeverity,
          level: z.number(),
          time: z.number(),
        })
        .optional(),
    })
    .meta({
      ref: "AegisSessionState",
    })
  export type SessionState = z.infer<typeof SessionState>

  export const Metrics = z
    .object({
      session_id: z.string(),
      mode: z.enum(["advisory"]),
      status: z.enum(["running", "paused"]),
      queue: z.number(),
      checks: z.number(),
      interventions: z.number(),
      unresolved: z.number(),
      model: z.string().optional(),
      tokens: z.object({
        input: z.number(),
        output: z.number(),
      }),
    })
    .meta({
      ref: "AegisMetrics",
    })
  export type Metrics = z.infer<typeof Metrics>

  export const Snapshot = z
    .object({
      state: SessionState,
      events: EventInfo.array(),
    })
    .meta({
      ref: "AegisSnapshot",
    })
  export type Snapshot = z.infer<typeof Snapshot>

  export const WorkspaceSession = z
    .object({
      session_id: z.string(),
      title: z.string(),
      updated: z.number(),
      mode: z.enum(["advisory"]),
      status: z.enum(["running", "paused"]),
      queue: z.number(),
      checks: z.number(),
      unresolved: z.number(),
      interventions: z.number(),
      model: z.string().optional(),
      tokens: z.object({
        input: z.number(),
        output: z.number(),
      }),
      last_violation: SessionState.shape.last_violation.optional(),
      last_intervention: SessionState.shape.last_intervention.optional(),
    })
    .meta({
      ref: "AegisWorkspaceSession",
    })
  export type WorkspaceSession = z.infer<typeof WorkspaceSession>

  export const RuleFeedback = z
    .object({
      score_7d: z.number(),
      count_7d: z.number(),
      last_feedback: z.number().optional(),
    })
    .meta({
      ref: "AegisRuleFeedback",
    })
  export type RuleFeedback = z.infer<typeof RuleFeedback>

  export const Workspace = z
    .object({
      supervisor: z.object({
        provider: z.string().optional(),
        model: z.string().optional(),
        configured: z.boolean(),
      }),
      rules: z.object({
        global: Rule.array(),
        project: Rule.array(),
        active: z.number(),
        total: z.number(),
        feedback_7d: z.record(z.string(), RuleFeedback),
      }),
      sessions: WorkspaceSession.array(),
      interventions: EventInfo.array(),
    })
    .meta({
      ref: "AegisWorkspace",
    })
  export type Workspace = z.infer<typeof Workspace>

  export const WorkspaceEvents = z
    .object({
      items: EventInfo.array(),
      next_cursor: z.number().optional(),
    })
    .meta({
      ref: "AegisWorkspaceEvents",
    })
  export type WorkspaceEvents = z.infer<typeof WorkspaceEvents>

  export const ThreadStatus = z.enum(["open", "watching", "resolved", "noisy"]).meta({
    ref: "AegisThreadStatus",
  })
  export type ThreadStatus = z.infer<typeof ThreadStatus>

  export const ComplianceVerdict = z.enum(["complied", "partial", "ignored", "unclear", "unknown"]).meta({
    ref: "AegisComplianceVerdict",
  })
  export type ComplianceVerdict = z.infer<typeof ComplianceVerdict>

  export const ResponseKind = z.enum(["assistant_text", "tool_call", "tool_result", "patch", "none"]).meta({
    ref: "AegisResponseKind",
  })
  export type ResponseKind = z.infer<typeof ResponseKind>

  export const Compliance = z
    .object({
      last_instruction: z.string().optional(),
      observed_response: z.string().optional(),
      response_kind: ResponseKind,
      verdict: ComplianceVerdict,
      followups: z.number(),
    })
    .meta({
      ref: "AegisCompliance",
    })
  export type Compliance = z.infer<typeof Compliance>

  export const Thread = z
    .object({
      key: z.string(),
      event_id: z.string(),
      session_id: z.string(),
      type: z.string(),
      fingerprint: z.string(),
      statement: z.string(),
      severity: RuleSeverity,
      level: z.number(),
      status: ThreadStatus,
      count: z.number(),
      first_seen: z.number(),
      last_seen: z.number(),
      rule_id: z.string().optional(),
      last_supervisor_message: z.string().optional(),
      helpfulness_score_7d: z.number(),
      feedback_count_7d: z.number(),
      compliance: Compliance,
    })
    .meta({
      ref: "AegisThread",
    })
  export type Thread = z.infer<typeof Thread>

  export const Now = z
    .object({
      state: z.enum(["watching", "intervening", "waiting_on_worker", "waiting_on_user_policy"]),
      session_id: z.string().optional(),
      session_title: z.string().optional(),
      agent: z.string().optional(),
      updated: z.number(),
    })
    .meta({
      ref: "AegisNow",
    })
  export type Now = z.infer<typeof Now>

  export const WorkspaceThreads = z
    .object({
      items: Thread.array(),
      now: Now,
      total: z.number(),
    })
    .meta({
      ref: "AegisWorkspaceThreads",
    })
  export type WorkspaceThreads = z.infer<typeof WorkspaceThreads>

  export const Event = {
    StateUpdated: BusEvent.define(
      "aegis.state.updated",
      z.object({
        sessionID: z.string(),
        state: SessionState,
      }),
    ),
    EventCreated: BusEvent.define(
      "aegis.event.created",
      z.object({
        sessionID: z.string(),
        event: EventInfo,
      }),
    ),
    RuleUpdated: BusEvent.define(
      "aegis.rule.updated",
      z.object({
        rule: Rule,
      }),
    ),
  }

  const Finding = z.object({
    fingerprint: z.string(),
    severity: RuleSeverity,
    statement: z.string(),
    instruction: z.string(),
    confidence: z.number(),
    rule_id: z.string().optional(),
    evidence: z.string().optional(),
    source: z.enum(["deterministic", "supervisor"]),
  })
  type Finding = z.infer<typeof Finding>

  const ReviewResult = z.object({
    findings: z.array(
      z.object({
        fingerprint: z.string(),
        severity: RuleSeverity,
        statement: z.string(),
        instruction: z.string(),
        confidence: z.number().min(0).max(1),
        evidence: z.string().min(3).max(280).optional(),
      }),
    ),
    resolves: z.array(z.string()).default([]),
  })

  const MemoryResult = z.object({
    memories: z
      .array(
        z.object({
          statement: z.string(),
          scope: RuleScope.optional(),
          confidence: z.number().min(0).max(1).default(0.7),
          policy: Policy.optional(),
        }),
      )
      .default([]),
  })

  const ObserveInput = z.object({
    sessionID: z.string(),
    messageID: z.string(),
    partID: z.string().optional(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()),
  })

  const ObserveResultInput = z.object({
    sessionID: z.string(),
    messageID: z.string(),
    partID: z.string().optional(),
    tool: z.string(),
    output: z.record(z.string(), z.unknown()),
  })

  const ObservePatchInput = z.object({
    sessionID: z.string(),
    messageID: z.string(),
    partID: z.string().optional(),
    files: z.string().array(),
  })

  export const ObserveTextInput = z.object({
    sessionID: z.string(),
    messageID: z.string(),
    partID: z.string().optional(),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
  })

  export const OverrideInput = z.object({
    sessionID: z.string().optional(),
    scope: RuleScope.default("project"),
    statement: z.string(),
    matcher: Matcher,
    severity: RuleSeverity.default("high"),
    active: z.boolean().optional().default(true),
  })

  export const FeedbackInput = z.object({
    sessionID: z.string().optional(),
    eventID: z.string(),
    helpful: z.boolean(),
    note: z.string().optional(),
    fingerprint: z.string().optional(),
    rule_id: z.string().optional(),
  })

  export const RuleUpdateInput = z.object({
    sessionID: z.string().optional(),
    ruleID: z.string(),
    statement: z.string().optional(),
    matcher: Matcher.optional(),
    severity: RuleSeverity.optional(),
    active: z.boolean().optional(),
    confirm_global: z.boolean().optional().default(false),
  })

  export const RuleDeleteInput = z.object({
    sessionID: z.string().optional(),
    ruleID: z.string(),
    confirm_global: z.boolean().optional().default(false),
  })

  export const DryRunInput = z.object({
    sessionID: z.string().optional(),
    matcher: Matcher,
    window_ms: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60 * 1000)
      .optional()
      .default(24 * 60 * 60 * 1000),
    limit_examples: z.number().int().positive().max(10).optional().default(3),
  })

  export const DryRunResult = z
    .object({
      matched: z.number(),
      examples: z.array(
        z.object({
          event_id: z.string(),
          session_id: z.string(),
          type: EventType,
          time: z.number(),
          summary: z.string(),
        }),
      ),
    })
    .meta({
      ref: "AegisDryRunResult",
    })
  export type DryRunResult = z.infer<typeof DryRunResult>

  export const ControlInput = z.object({
    sessionID: z.string(),
    action: z.enum(["pause", "resume"]),
  })

  export const WorkspaceEventsInput = z.object({
    limit: z.number().int().positive().max(200).default(100),
    cursor: z.number().int().positive().optional(),
  })

  export const WorkspaceThreadsInput = z.object({
    limit: z.number().int().positive().max(200).default(100),
    window_ms: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60 * 1000)
      .default(24 * 60 * 60 * 1000),
    status: ThreadStatus.optional(),
    severity: RuleSeverity.optional(),
    type: z.enum(["violation", "intervention_injected", "escalation"]).optional(),
    session_id: z.string().optional(),
    preset: z.enum(["active_fire", "new_regressions", "noisy_rules", "supervisor_struggling"]).optional(),
  })

  const Observation = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    partID: z.string().optional(),
    kind: z.enum(["tool_call", "tool_result", "assistant_text", "patch"]),
    tool: z.string().optional(),
    text: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
    time: z.number(),
  })
  type Observation = z.infer<typeof Observation>
  type IssuePhase = "open" | "awaiting_compliance" | "stalled"
  type IssueState = {
    count: number
    level: number
    severity: RuleSeverity
    statement: string
    instruction: string
    evidence?: string
    rule_id?: string
    phase: IssuePhase
    time: number
    open: boolean
    followups: number
    last_injected_at?: number
    last_observed_at: number
    last_progress_at?: number
    holdoff_until?: number
    suppression_reason?: string
  }

  type RepoContext = {
    family?: string
    markers: string[]
  }

  const state = Instance.state(() => {
    return {
      bootstrapped: false,
      mining: new Set<string>(),
      repo: undefined as RepoContext | undefined,
      supervisor: {} as Record<
        string,
        {
          queue: Observation[]
          processing: boolean
          paused: boolean
          issues: Record<string, IssueState>
          injected: Record<string, number>
        }
      >,
    }
  })

  function toRule(row: typeof AegisRuleTable.$inferSelect): Rule {
    return {
      id: row.id,
      scope: row.scope,
      project_id: row.project_id ?? undefined,
      kind: row.kind,
      statement: row.statement,
      matcher: row.matcher,
      severity: row.severity,
      confidence: row.confidence / 100,
      source: row.source ?? undefined,
      active: row.active === 1,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function toEvent(row: typeof AegisEventTable.$inferSelect): EventInfo {
    return {
      id: row.id,
      session_id: row.session_id,
      message_id: row.message_id ?? undefined,
      part_id: row.part_id ?? undefined,
      rule_id: row.rule_id ?? undefined,
      type: row.type,
      payload: row.payload,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function payloadText(payload: Record<string, unknown>, key: string) {
    const value = payload[key]
    if (typeof value === "string") return value
    return undefined
  }

  function payloadNum(payload: Record<string, unknown>, key: string, fallback = 0) {
    const value = payload[key]
    if (typeof value === "number") return value
    return fallback
  }

  function payloadSeverity(payload: Record<string, unknown>) {
    const value = payload.severity
    if (value === "low" || value === "medium" || value === "high") return value
    return "medium"
  }

  function payloadFingerprint(payload: Record<string, unknown>) {
    const value = payload.fingerprint
    if (typeof value === "string" && value.length > 0) return value
    return undefined
  }

  function summarizeEvent(event: EventInfo) {
    const payload = event.payload
    const statement = payloadText(payload, "statement")
    if (statement) return statement
    const reason = payloadText(payload, "reason")
    if (reason) return reason
    const issue = payloadText(payload, "issue")
    if (issue) return issue
    if (event.type === "observe_tool_call") {
      const tool = payloadText(payload, "tool") ?? "tool"
      return `Tool call: ${tool}`
    }
    if (event.type === "observe_tool_result") {
      const tool = payloadText(payload, "tool") ?? "tool"
      return `Tool result: ${tool}`
    }
    if (event.type === "observe_patch") {
      const files = event.payload.files
      if (Array.isArray(files)) {
        const first = files.filter((item): item is string => typeof item === "string").slice(0, 2)
        if (first.length > 0) return `Patch: ${first.join(", ")}`
      }
      return "Patch observed"
    }
    if (event.type === "observe_text") {
      const text = payloadText(payload, "text")
      if (text) return text.slice(0, 140)
    }
    return event.type.replaceAll("_", " ")
  }

  function complianceFrom(input: { events: EventInfo[]; fingerprint: string }) {
    const fingerprintEvents = input.events.filter((event) => payloadFingerprint(event.payload) === input.fingerprint)
    const interventions = fingerprintEvents.filter((event) => event.type === "intervention_injected")
    const latestIntervention = interventions.at(-1)
    if (!latestIntervention) {
      return Compliance.parse({
        response_kind: "none",
        verdict: "unknown",
        followups: 0,
      })
    }

    const latestInterventionTime = latestIntervention.time.created
    const after = fingerprintEvents.filter((event) => event.time.created >= latestInterventionTime)
    const observed = input.events.find((event) => {
      if (event.time.created < latestInterventionTime) return false
      return (
        event.type === "observe_text" ||
        event.type === "observe_tool_call" ||
        event.type === "observe_tool_result" ||
        event.type === "observe_patch"
      )
    })
    const resolved = after.some((event) => event.type === "issue_resolved")
    const unresolved = after.some((event) => event.type === "issue_unresolved" || event.type === "escalation")
    const followups = Math.max(0, interventions.length - 1)
    const responseKind = observed
      ? observed.type === "observe_text"
        ? "assistant_text"
        : observed.type === "observe_patch"
          ? "patch"
          : observed.type === "observe_tool_result"
            ? "tool_result"
            : "tool_call"
      : "none"

    const verdict = (() => {
      if (resolved && !unresolved) return "complied" as const
      if (resolved && unresolved) return "partial" as const
      if (!observed && unresolved && followups > 0) return "ignored" as const
      if (observed && unresolved) return "partial" as const
      if (observed && !resolved) return "unclear" as const
      if (!observed && unresolved) return "ignored" as const
      return "unknown" as const
    })()

    return Compliance.parse({
      last_instruction: payloadText(latestIntervention.payload, "instruction"),
      observed_response: observed ? summarizeEvent(observed) : undefined,
      response_kind: responseKind,
      verdict,
      followups,
    })
  }

  type FeedbackAgg = {
    score: number
    count: number
    last?: number
  }

  function feedbackAcc(input: { map: Map<string, FeedbackAgg>; key?: string; helpful: boolean; time: number }) {
    if (!input.key) return
    const prev = input.map.get(input.key) ?? { score: 0, count: 0, last: undefined }
    input.map.set(input.key, {
      score: prev.score + (input.helpful ? 1 : -1),
      count: prev.count + 1,
      last: Math.max(prev.last ?? 0, input.time),
    })
  }

  function matcherKey(matcher: Matcher) {
    return [matcher.tool ?? "*", matcher.pattern ?? "*", matcher.not_pattern ?? ""].join("::")
  }

  function ruleKey(rule: Rule) {
    if (rule.matcher.pattern) return matcherKey(rule.matcher)
    return [rule.scope, "memory", rule.statement.toLowerCase().trim()].join("::")
  }

  function hash(text: string) {
    return Bun.hash.xxHash32(text).toString(36)
  }

  function severityScore(severity: RuleSeverity) {
    if (severity === "high") return 3
    if (severity === "medium") return 2
    return 1
  }

  function contains(text: string, pattern: string) {
    const query = pattern.toLowerCase().trim()
    if (!query) return false
    if (!query.includes("|")) return text.includes(query)
    return query.split("|").some((item) => text.includes(item.trim()))
  }

  function extract(text: string, re: RegExp) {
    const result: string[] = []
    for (const item of text.matchAll(re)) {
      const value = item[1]?.trim()
      if (!value) continue
      if (value.length < 2) continue
      if (value.length > 120) continue
      result.push(value)
    }
    return Array.from(new Set(result))
  }

  function clean(text: string) {
    return text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^(that|to)\s+/i, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/[\s;:,.!?]+$/g, "")
      .trim()
  }

  function memoryScope(text: string): RuleScope {
    const low = text.toLowerCase()
    if (low.includes("all projects")) return "global"
    if (low.includes("across projects")) return "global"
    if (low.includes("globally")) return "global"
    return "project"
  }

  function memoryText(role: "user" | "assistant", text: string) {
    const result: string[] = []
    const raw = text.trim()
    if (!raw) return result
    const lines = raw
      .split(/\n+/)
      .map((line) => clean(line))
      .filter((line) => line.length >= 4 && line.length <= 220)

    for (const line of lines) {
      for (const item of line.matchAll(/\b(?:remember|note|store|keep in mind)\b(?:[^:\n]*?[:,-]\s*|\s+)(.+)/gi)) {
        const value = clean(item[1] ?? "")
        if (value) result.push(value)
      }
    }

    for (let i = 0; i < lines.length - 1; i++) {
      const current = lines[i]!.toLowerCase()
      if (!/^(remember|note|store|keep in mind)(?:\s+this)?[:,-]?$/.test(current)) continue
      const next = clean(lines[i + 1]!)
      if (next) result.push(next)
    }

    const chunks = lines.flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((line) => clean(line))
    for (const line of chunks) {
      const low = line.toLowerCase()
      if (low.includes("for this project") || low.includes("in this project") || low.includes("in this repo")) {
        result.push(line)
        continue
      }
      if (/^(?:we\s+)?always\s+/.test(low)) {
        result.push(line)
        continue
      }
      if (/^(?:we\s+)?never\s+/.test(low)) {
        result.push(line)
        continue
      }
      if (/^(?:do not|don't|avoid)\s+/.test(low)) {
        result.push(line)
        continue
      }
    }

    return Array.from(new Set(result.map(clean)))
      .filter((line) => line.length >= 6 && line.length <= 180)
      .slice(0, 5)
  }

  function ephemeralAssistantMemory(text: string) {
    const low = text.toLowerCase().trim()
    return (
      /^(?:i(?:'ll| will)|we(?:'ll| will)|i am going to|we are going to)\b/.test(low) ||
      low.includes("as suggested") ||
      low.includes("as requested") ||
      low.includes("as instructed") ||
      low.includes("as asked")
    )
  }

  function durableAssistantMemory(text: string) {
    const low = text.toLowerCase()
    return (
      low.includes("for this project") ||
      low.includes("in this project") ||
      low.includes("all projects") ||
      low.includes("across projects") ||
      low.includes("globally") ||
      low.includes("always ") ||
      low.includes("never ") ||
      low.includes("avoid ") ||
      low.includes("prefer ") ||
      low.includes("default stack") ||
      /#[0-9a-f]{3,8}\b/i.test(text) ||
      /\/[a-z0-9][a-z0-9_-]{1,}/i.test(text)
    )
  }

  function memorySignal(text: string) {
    const low = text.toLowerCase()
    if (low.includes("remember")) return true
    if (low.includes("keep in mind")) return true
    if (low.includes("for this project")) return true
    if (low.includes("in this project")) return true
    if (low.includes("always ")) return true
    if (low.includes("never ")) return true
    if (low.includes("avoid ")) return true
    if (/#[0-9a-f]{3,8}\b/i.test(text)) return true
    if (/\/[a-z0-9][a-z0-9_-]{1,}/i.test(text)) return true
    return false
  }

  async function memoryMine(input: { role: "user" | "assistant"; text: string }) {
    if (process.env.NODE_ENV === "test")
      return [] as Array<{ statement: string; scope: RuleScope; confidence: number; policy?: Policy }>
    if (!memorySignal(input.text))
      return [] as Array<{ statement: string; scope: RuleScope; confidence: number; policy?: Policy }>
    const cfg = await Config.get()
    if (cfg.aegis?.enabled === false)
      return [] as Array<{ statement: string; scope: RuleScope; confidence: number; policy?: Policy }>

    const pick =
      cfg.aegis?.provider && cfg.aegis?.model
        ? {
            providerID: cfg.aegis.provider,
            modelID: cfg.aegis.model,
          }
        : await Provider.defaultModel()

    const model = await Provider.getModel(pick.providerID, pick.modelID)
    const language = await Provider.getLanguage(model)
    const msgs: ModelMessage[] = [
      {
        role: "system",
        content: [
          "You are Aegis memory tool.",
          "Extract only durable project memory candidates from the message.",
          "Prefer style cues, required skills, technology constraints, and persistent preferences.",
          "If user says remember/note/store, keep the remembered value verbatim when possible.",
          "When role is assistant, ignore one-off execution promises or acknowledgements (like I'll do X as suggested).",
          "When memory states a durable stack policy (ex: default stack when unspecified), include policy intent/target/condition.",
          "If no durable memory exists, return an empty list.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          role: input.role,
          text: input.text,
        }),
      },
    ]
    const schema = MemoryResult
    const isCodex = model.providerID === "openai" && (await Auth.get(model.providerID))?.type === "oauth"
    if (isCodex) {
      const result = streamObject({
        model: language,
        schema,
        temperature: 0,
        maxOutputTokens: 300,
        messages: msgs,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      const value = schema.parse(result.object)
      return value.memories
        .map((item) => ({
          statement: clean(item.statement),
          scope: item.scope ?? memoryScope(item.statement),
          confidence: item.confidence,
          policy: normalizePolicy(item.policy) ?? statementPolicy(item.statement),
        }))
        .filter((item) => item.statement.length >= 6 && item.statement.length <= 180 && item.confidence >= 0.55)
        .filter((item) =>
          input.role === "assistant"
            ? !ephemeralAssistantMemory(item.statement) && (durableAssistantMemory(item.statement) || !!item.policy)
            : true,
        )
        .slice(0, 5)
    }

    const result = await generateObject({
      model: language,
      schema,
      temperature: 0,
      maxOutputTokens: 300,
      messages: msgs,
    })
    const value = schema.parse(result.object)
    return value.memories
      .map((item) => ({
        statement: clean(item.statement),
        scope: item.scope ?? memoryScope(item.statement),
        confidence: item.confidence,
        policy: normalizePolicy(item.policy) ?? statementPolicy(item.statement),
      }))
      .filter((item) => item.statement.length >= 6 && item.statement.length <= 180 && item.confidence >= 0.55)
      .filter((item) =>
        input.role === "assistant"
          ? !ephemeralAssistantMemory(item.statement) && (durableAssistantMemory(item.statement) || !!item.policy)
          : true,
      )
      .slice(0, 5)
  }

  function normalizeState(
    input: Partial<SessionState>,
    sessionID: string,
    rules: { global: number; project: number; active: number },
  ) {
    return SessionState.parse({
      session_id: sessionID,
      mode: "advisory",
      status: input.status ?? "running",
      queue: input.queue ?? 0,
      checks: input.checks ?? 0,
      unresolved: input.unresolved ?? 0,
      model: input.model,
      tokens: {
        input: input.tokens?.input ?? 0,
        output: input.tokens?.output ?? 0,
      },
      interventions: input.interventions ?? 0,
      rules,
      mining: {
        status: input.mining?.status ?? "idle",
        last_run: input.mining?.last_run,
      },
      last_violation: input.last_violation,
      last_intervention: input.last_intervention,
    })
  }

  async function countRules() {
    const rows = Database.use((db) =>
      db
        .select({
          scope: AegisRuleTable.scope,
          active: AegisRuleTable.active,
          count: sql<number>`count(*)`,
        })
        .from(AegisRuleTable)
        .where(
          sql`${AegisRuleTable.scope} = 'global' OR (${AegisRuleTable.scope} = 'project' AND ${AegisRuleTable.project_id} = ${Instance.project.id})`,
        )
        .groupBy(AegisRuleTable.scope, AegisRuleTable.active)
        .all(),
    )
    return rows.reduce(
      (agg, row) => {
        if (row.scope === "global" && row.active === 1) agg.global += row.count
        if (row.scope === "project" && row.active === 1) agg.project += row.count
        if (row.active === 1) agg.active += row.count
        return agg
      },
      { global: 0, project: 0, active: 0 },
    )
  }

  async function currentState(sessionID: string) {
    const rules = await countRules()
    const row = Database.use((db) =>
      db.select().from(AegisSessionTable).where(eq(AegisSessionTable.session_id, sessionID)).get(),
    )
    if (row) {
      const next = normalizeState(row.state, sessionID, rules)
      if (JSON.stringify(next) !== JSON.stringify(row.state)) {
        Database.use((db) =>
          db
            .insert(AegisSessionTable)
            .values({
              session_id: sessionID,
              state: next,
            })
            .onConflictDoUpdate({
              target: AegisSessionTable.session_id,
              set: { state: next },
            })
            .run(),
        )
      }
      return next
    }

    const next = normalizeState({}, sessionID, rules)
    Database.use((db) =>
      db
        .insert(AegisSessionTable)
        .values({
          session_id: sessionID,
          state: next,
        })
        .onConflictDoUpdate({
          target: AegisSessionTable.session_id,
          set: { state: next },
        })
        .run(),
    )
    return next
  }

  async function writeState(sessionID: string, updater: (state: SessionState) => SessionState) {
    const now = await currentState(sessionID)
    const rules = await countRules()
    const next = normalizeState(updater(now), sessionID, rules)
    Database.use((db) =>
      db
        .insert(AegisSessionTable)
        .values({
          session_id: sessionID,
          state: next,
        })
        .onConflictDoUpdate({
          target: AegisSessionTable.session_id,
          set: { state: next },
        })
        .run(),
    )
    await Bus.publish(Event.StateUpdated, {
      sessionID,
      state: next,
    })
    return next
  }

  async function createRule(input: {
    scope: RuleScope
    projectID?: string
    kind: RuleKind
    statement: string
    matcher: Matcher
    severity: RuleSeverity
    confidence: number
    source?: RuleSource
    active?: boolean
  }) {
    const all = Database.use((db) =>
      db
        .select()
        .from(AegisRuleTable)
        .where(
          and(
            eq(AegisRuleTable.scope, input.scope),
            input.scope === "project"
              ? eq(AegisRuleTable.project_id, input.projectID ?? "")
              : isNull(AegisRuleTable.project_id),
          ),
        )
        .all(),
    )
    const duplicate = all.find((row) => {
      if (row.statement !== input.statement) return false
      return matcherKey(row.matcher) === matcherKey(input.matcher)
    })
    if (duplicate) return toRule(duplicate)

    const id = ulid()
    Database.use((db) =>
      db
        .insert(AegisRuleTable)
        .values({
          id,
          scope: input.scope,
          project_id: input.scope === "project" ? (input.projectID ?? null) : null,
          kind: input.kind,
          statement: input.statement,
          matcher: input.matcher,
          severity: input.severity,
          confidence: Math.round(Math.max(0, Math.min(1, input.confidence)) * 100),
          source: input.source,
          active: input.active === false ? 0 : 1,
        })
        .run(),
    )

    const row = Database.use((db) => db.select().from(AegisRuleTable).where(eq(AegisRuleTable.id, id)).get())
    if (!row) throw new Error("Failed to create aegis rule")
    const info = toRule(row)
    await Bus.publish(Event.RuleUpdated, {
      rule: info,
    })
    return info
  }

  async function recordEvent(input: {
    sessionID: string
    messageID?: string
    partID?: string
    ruleID?: string
    type: EventType
    payload: Record<string, unknown>
  }) {
    const id = ulid()
    Database.use((db) =>
      db
        .insert(AegisEventTable)
        .values({
          id,
          session_id: input.sessionID,
          message_id: input.messageID,
          part_id: input.partID,
          rule_id: input.ruleID,
          type: input.type,
          payload: input.payload,
        })
        .run(),
    )
    const row = Database.use((db) => db.select().from(AegisEventTable).where(eq(AegisEventTable.id, id)).get())
    if (!row) throw new Error("Failed to create aegis event")
    const info = toEvent(row)
    await Bus.publish(Event.EventCreated, {
      sessionID: input.sessionID,
      event: info,
    })
    return info
  }

  async function activeRules() {
    const all = Database.use((db) =>
      db
        .select()
        .from(AegisRuleTable)
        .where(
          and(
            eq(AegisRuleTable.active, 1),
            sql`${AegisRuleTable.scope} = 'global' OR (${AegisRuleTable.scope} = 'project' AND ${AegisRuleTable.project_id} = ${Instance.project.id})`,
          ),
        )
        .all(),
    ).map(toRule)

    const sorted = all.toSorted((a, b) => {
      const weight =
        (a.scope === "project" ? 10 : 0) + (a.kind === "explicit" ? 10 : 0) + (a.kind === "runtime" ? 2 : 0)
      const other = (b.scope === "project" ? 10 : 0) + (b.kind === "explicit" ? 10 : 0) + (b.kind === "runtime" ? 2 : 0)
      if (weight !== other) return weight - other
      return a.time.updated - b.time.updated
    })

    const map = new Map<string, Rule>()
    for (const rule of sorted) {
      map.set(ruleKey(rule), rule)
    }
    return Array.from(map.values())
  }

  function instructionScope(filepath: string): RuleScope {
    const resolved = path.resolve(filepath)
    const worktree = path.resolve(Instance.worktree)
    if (resolved === worktree || resolved.startsWith(worktree + path.sep)) return "project"
    return "global"
  }

  async function bootstrapInstructions() {
    const paths = await InstructionPrompt.systemPaths()
    const created: Rule[] = []
    for (const filepath of paths) {
      const text = await Bun.file(filepath)
        .text()
        .catch(() => "")
      if (!text) continue
      const scope = instructionScope(filepath)
      const statements = [
        ...extract(text, /\bnever\s+(?:use|touch|modify)\s+([^\n\.,;]+)/gi),
        ...extract(text, /\bavoid\s+([^\n\.,;]+)/gi),
        ...extract(text, /\bdon'?t\s+use\s+([^\n\.,;]+)/gi),
      ]
      for (const item of statements) {
        const info = await createRule({
          scope,
          projectID: scope === "project" ? Instance.project.id : undefined,
          kind: "mined",
          statement: `Avoid ${item}`,
          matcher: {
            pattern: item,
          },
          severity: "high",
          confidence: 0.9,
          source: {
            type: "instruction",
            value: filepath,
          },
        })
        created.push(info)
      }
    }
    return created
  }

  async function bootstrapPackageRules() {
    const filepath = path.join(Instance.worktree, "package.json")
    const exists = await Bun.file(filepath)
      .exists()
      .catch(() => false)
    if (!exists) return []

    const json = await Bun.file(filepath)
      .json()
      .catch(() => undefined)
    if (!json || typeof json !== "object") return []

    const root = json as Record<string, unknown>
    const dependencies = {
      ...((root.dependencies && typeof root.dependencies === "object"
        ? (root.dependencies as Record<string, unknown>)
        : {}) ?? {}),
      ...((root.devDependencies && typeof root.devDependencies === "object"
        ? (root.devDependencies as Record<string, unknown>)
        : {}) ?? {}),
    }

    const rules: Rule[] = []
    if ("zod" in dependencies) {
      rules.push(
        await createRule({
          scope: "project",
          projectID: Instance.project.id,
          kind: "runtime",
          statement: "Use Zod for validation in this project",
          matcher: {
            tool: "edit",
            pattern: "joi|yup",
          },
          severity: "medium",
          confidence: 0.8,
          source: {
            type: "package",
            value: filepath,
          },
        }),
      )
    }

    if ("convex" in dependencies) {
      rules.push(
        await createRule({
          scope: "project",
          projectID: Instance.project.id,
          kind: "runtime",
          statement: "Convex is a project invariant unless explicitly overridden",
          matcher: {
            pattern: "supabase|firebase|hasura",
          },
          severity: "high",
          confidence: 0.85,
          source: {
            type: "package",
            value: filepath,
          },
        }),
      )
    }

    return rules
  }

  async function ensureBootstrapped() {
    if (state().bootstrapped) return
    if ((await activeRules()).length > 0) {
      state().bootstrapped = true
      return
    }

    const created = [...(await bootstrapInstructions()), ...(await bootstrapPackageRules())]
    state().bootstrapped = true
    if (created.length > 0) return

    await createRule({
      scope: "project",
      projectID: Instance.project.id,
      kind: "runtime",
      statement: "Prefer existing project patterns over introducing new frameworks",
      matcher: {
        pattern: "new framework|switch framework",
      },
      severity: "low",
      confidence: 0.6,
      source: {
        type: "runtime",
        value: "aegis-default",
      },
    })
  }

  async function mineHistory(sessionID: string) {
    const s = state()
    if (s.mining.has(sessionID)) return
    s.mining.add(sessionID)

    await writeState(sessionID, (current) => ({
      ...current,
      mining: {
        status: "running",
        last_run: current.mining.last_run,
      },
    }))

    const result = await git(["log", "-n", "200", "--pretty=format:%s"], {
      cwd: Instance.worktree,
    })

    if (result.exitCode === 0) {
      const messages = (await result.text()).split("\n")
      const phrases = messages.flatMap((line) => {
        return [
          ...extract(line, /\bnever\s+(?:use|touch|modify)\s+([^\n\.,;]+)/gi),
          ...extract(line, /\bavoid\s+([^\n\.,;]+)/gi),
        ]
      })
      for (const item of Array.from(new Set(phrases)).slice(0, 20)) {
        await createRule({
          scope: "global",
          kind: "runtime",
          statement: `History hint: avoid ${item}`,
          matcher: {
            pattern: item,
          },
          severity: "medium",
          confidence: 0.55,
          source: {
            type: "history",
            value: "git-log",
          },
        })
      }
    }

    await writeState(sessionID, (current) => ({
      ...current,
      mining: {
        status: "done",
        last_run: Date.now(),
      },
    }))

    s.mining.delete(sessionID)
  }

  function shouldReview(kind: Observation["kind"], cfg: z.output<typeof Config.Info>) {
    const review = cfg.aegis?.review
    if (!review) return true
    if (kind === "tool_call") return review.tool_call !== false
    if (kind === "tool_result") return review.tool_result !== false
    if (kind === "assistant_text") return review.assistant_text !== false
    return review.patch !== false
  }

  function sessionSupervisor(sessionID: string) {
    const s = state()
    if (!s.supervisor[sessionID]) {
      s.supervisor[sessionID] = {
        queue: [],
        processing: false,
        paused: false,
        issues: {},
        injected: {},
      }
    }
    return s.supervisor[sessionID]
  }

  function normalizeText(observation: Observation) {
    if (observation.kind === "assistant_text") return (observation.text ?? "").toLowerCase()
    if (observation.kind === "patch") {
      return JSON.stringify(observation.payload).toLowerCase()
    }
    return JSON.stringify(observation.payload).toLowerCase()
  }

  function matchesRule(rule: Rule, observation: Observation, text: string) {
    const matcher = rule.matcher
    if (!matcher.pattern) return false
    if (matcher.tool && matcher.tool !== "*" && matcher.tool !== (observation.tool ?? "")) return false
    if (!contains(text, matcher.pattern)) return false
    if (matcher.not_pattern && contains(text, matcher.not_pattern)) return false
    return true
  }

  function deterministicFindings(observation: Observation, rules: Rule[]) {
    const text = normalizeText(observation)
    return rules
      .filter((rule) => matchesRule(rule, observation, text))
      .map((rule) => {
        return Finding.parse({
          fingerprint: `rule:${rule.id}`,
          severity: rule.severity,
          statement: rule.statement,
          instruction: `Adjust your approach to satisfy: ${rule.statement}`,
          confidence: rule.confidence,
          rule_id: rule.id,
          evidence: rule.matcher.pattern,
          source: "deterministic",
        })
      })
  }

  const stackTargets = [
    { id: "nextjs", label: "Next.js", aliases: ["nextjs", "next.js"] },
    { id: "react", label: "React", aliases: ["react"] },
    { id: "vue", label: "Vue", aliases: ["vue"] },
    { id: "svelte", label: "Svelte", aliases: ["svelte"] },
    { id: "nuxt", label: "Nuxt", aliases: ["nuxt"] },
    { id: "remix", label: "Remix", aliases: ["remix"] },
    { id: "astro", label: "Astro", aliases: ["astro"] },
  ] as const

  function stackFromText(text: string) {
    const low = text.toLowerCase()
    return stackTargets.find((target) => target.aliases.some((alias) => low.includes(alias)))
  }

  function normalizePolicy(policy?: Policy) {
    if (!policy) return
    if (policy.intent !== "default_stack") return
    const target = stackFromText(policy.target)
    if (!target) return
    return Policy.parse({
      intent: "default_stack",
      target: target.id,
      condition: policy.condition ?? "if_no_stack_specified",
    })
  }

  function statementPolicy(statement: string) {
    const low = statement.toLowerCase()
    if (!low.includes("stack")) return
    if (!low.includes("default") && !low.includes("always")) return
    if (!low.includes("if no stack")) return
    const target = stackFromText(low)
    if (!target) return
    return Policy.parse({
      intent: "default_stack",
      target: target.id,
      condition: "if_no_stack_specified",
    })
  }

  function rulePolicy(rule: Rule) {
    return normalizePolicy(rule.matcher.policy) ?? statementPolicy(rule.statement)
  }

  function payloadStrings(payload: unknown): string[] {
    if (typeof payload === "string") return [payload]
    if (Array.isArray(payload)) return payload.flatMap((item) => payloadStrings(item))
    if (!payload || typeof payload !== "object") return []
    return Object.values(payload).flatMap((item) => payloadStrings(item))
  }

  function sourceSignals(observation: Observation) {
    const raw =
      observation.kind === "assistant_text" ? (observation.text ?? "") : JSON.stringify(observation.payload ?? {})
    const source = raw.toLowerCase()
    const files =
      observation.kind === "patch"
        ? ((observation.payload.files as string[] | undefined) ?? [])
        : payloadStrings(observation.payload)
            .map((item) => item.trim())
            .filter((item) => item.length >= 3 && item.length <= 220)
            .filter(
              (item) =>
                /[\\/]/.test(item) || /\.[a-z0-9]{2,8}\b/i.test(item) || /^(?:\.\.\/|\.\/)?[a-z0-9._-]+$/i.test(item),
            )
    return {
      source,
      files,
    }
  }

  function projectPath(file: string) {
    const cleaned = file.trim().replace(/^["'`]+|["'`]+$/g, "")
    if (!cleaned) return
    const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(Instance.worktree, cleaned)
    const rel = path.relative(Instance.worktree, abs).replaceAll("\\", "/")
    if (rel.startsWith("../") || rel === "..") return
    return rel.replace(/^\.\/+/, "")
  }

  function rootHtml(files: string[]) {
    return files.find((item) => {
      const rel = projectPath(item)
      if (!rel) return false
      return rel.toLowerCase() === "index.html"
    })
  }

  function plainStack(input: { source: string; files: string[] }) {
    const root = rootHtml(input.files)
    if (root) return root
    const source = input.source
    const match =
      source.match(/\bhtml\b[\s,/+-]*\bcss\b[\s,/+-]*(?:\bjs\b|\bjavascript\b)/) ??
      source.match(/\bhtml\/css\/(?:js|javascript)\b/) ??
      source.match(/\bplain\s+html\b/) ??
      source.match(/\bvanilla\s+(?:js|javascript)\b/) ??
      source.match(/\bwithout\s+(?:a\s+)?framework\b/) ??
      source.match(/\bindex\.html\b/)
    return match?.[0]
  }

  function conflictingStack(input: { source: string; target: string }) {
    return stackTargets.find((stack) => {
      if (stack.id === input.target) return false
      return stack.aliases.some((alias) => input.source.includes(alias))
    })
  }

  function explicitOverride(source: string) {
    return (
      source.includes("user explicitly asked") ||
      source.includes("user explicitly requested") ||
      source.includes("as user requested") ||
      source.includes("per user request")
    )
  }

  function textPaths(text: string) {
    const result = new Set<string>()
    for (const raw of text.split(/\s+/)) {
      const item = raw.replace(/^[`"'(\[]+|[`"')\].,;:!?]+$/g, "")
      if (!item) continue
      const low = item.toLowerCase()
      if (low.startsWith("http://") || low.startsWith("https://")) continue
      if (!item.includes("/") && !/\.[a-z0-9]{2,8}$/i.test(item)) continue
      const rel = projectPath(item)
      if (!rel) continue
      result.add(rel.toLowerCase())
      if (result.size >= 12) break
    }
    return Array.from(result)
  }

  type UserIntent = {
    text: string
    paths: string[]
    wants_tests: boolean
  }

  function intentText(text: string) {
    const low = text.toLowerCase()
    return {
      text,
      paths: textPaths(text),
      wants_tests:
        low.includes(" test") ||
        low.includes("tests") ||
        low.includes("spec") ||
        low.includes("unit") ||
        low.includes("integration"),
    }
  }

  async function latestUserText(sessionID: string) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role !== "user") continue
      const text = item.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
      if (text) return text
    }
  }

  const families = [
    {
      id: "node",
      label: "Node.js/TypeScript",
      markers: ["package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
      patterns: [/\bnode(?:\.js)?\b/, /\bjavascript\b/, /\btypescript\b/, /\bnpm\b/, /\bbun\b/],
    },
    {
      id: "python",
      label: "Python",
      markers: ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py"],
      patterns: [/\bpython\b/, /\bpyproject\.toml\b/, /\brequirements\.txt\b/, /\.(?:py|pyi)\b/],
    },
    {
      id: "go",
      label: "Go",
      markers: ["go.mod", "go.sum", "go.work"],
      patterns: [/\bgolang\b/, /\bgo\.mod\b/, /\bgo\.sum\b/, /\.go\b/],
    },
    {
      id: "rust",
      label: "Rust",
      markers: ["Cargo.toml", "Cargo.lock"],
      patterns: [/\brust\b/, /\bcargo\b/, /\bcargo\.toml\b/, /\.rs\b/],
    },
    {
      id: "java",
      label: "Java",
      markers: ["pom.xml", "build.gradle", "build.gradle.kts"],
      patterns: [/\bjava\b/, /\bgradle\b/, /\bmaven\b/, /\bpom\.xml\b/, /\.java\b/],
    },
    {
      id: "dotnet",
      label: ".NET",
      markers: ["global.json", "Directory.Build.props"],
      patterns: [/\bc#\b/, /\bdotnet\b/, /\.csproj\b/, /\.sln\b/, /\.cs\b/],
    },
    {
      id: "ruby",
      label: "Ruby",
      markers: ["Gemfile", "Gemfile.lock"],
      patterns: [/\bruby\b/, /\brails\b/, /\bgemfile\b/, /\.rb\b/],
    },
    {
      id: "php",
      label: "PHP",
      markers: ["composer.json", "composer.lock"],
      patterns: [/\bphp\b/, /\bcomposer\b/, /\.php\b/],
    },
  ] as const

  function familyFromSource(text: string) {
    const low = text.toLowerCase()
    const hits = families.filter((item) => item.patterns.some((re) => re.test(low)))
    if (hits.length !== 1) return
    return hits[0]
  }

  async function repoContext() {
    const cached = state().repo
    if (cached) return cached
    const rows = await Promise.all(
      families.map(async (item) => {
        const checks = await Promise.all(
          item.markers.map((marker) =>
            Bun.file(path.join(Instance.worktree, marker))
              .exists()
              .catch(() => false),
          ),
        )
        const hit = checks.some((value) => value)
        return {
          id: item.id,
          hit,
        }
      }),
    )
    const markers = rows.filter((row) => row.hit).map((row) => row.id)
    const family = markers.length === 1 ? markers[0] : undefined
    const value = {
      family,
      markers,
    }
    state().repo = value
    return value
  }

  function completionClaim(text: string) {
    return /\b(done|completed|finished|implemented|fixed|resolved|shipped|delivered)\b/i.test(text)
  }

  function testSignal(text: string) {
    const low = text.toLowerCase()
    return (
      low.includes(" test") ||
      low.includes("tests") ||
      low.includes("spec") ||
      low.includes("pytest") ||
      low.includes("jest") ||
      low.includes("vitest") ||
      low.includes("go test") ||
      low.includes("cargo test") ||
      low.includes("phpunit") ||
      low.includes("rspec")
    )
  }

  function testFile(file: string) {
    const low = file.toLowerCase()
    return (
      low.includes("/__tests__/") ||
      low.includes("/tests/") ||
      low.includes(".test.") ||
      low.includes(".spec.") ||
      /(^|\/)test_[^/]+\.[a-z0-9]+$/i.test(low)
    )
  }

  function pathMatch(a: string, b: string) {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  }

  function eventSignals(event: EventInfo) {
    if (event.type === "observe_patch") {
      const files = Array.isArray(event.payload.files)
        ? event.payload.files
            .filter((item): item is string => typeof item === "string")
            .map((item) => projectPath(item))
            .filter((item): item is string => !!item)
        : []
      return {
        source: JSON.stringify(event.payload).toLowerCase(),
        files,
      }
    }
    const source = JSON.stringify(event.payload).toLowerCase()
    const files = payloadStrings(event.payload)
      .map((item) => projectPath(item))
      .filter((item): item is string => !!item)
    return {
      source,
      files,
    }
  }

  function pathEvidence(input: { requested: string[]; seen: string[] }) {
    if (!input.requested.length) return true
    if (!input.seen.length) return false
    return input.requested.some((request) => input.seen.some((file) => pathMatch(request, file)))
  }

  function testEvidence(input: { source: string; seen: string[]; recent: EventInfo[] }) {
    if (testSignal(input.source)) return true
    if (input.seen.some((file) => testFile(file))) return true
    return input.recent.some((event) => {
      if (
        event.type !== "observe_tool_call" &&
        event.type !== "observe_tool_result" &&
        event.type !== "observe_patch"
      ) {
        return false
      }
      const signals = eventSignals(event)
      if (testSignal(signals.source)) return true
      return signals.files.some((file) => testFile(file))
    })
  }

  async function contextFindings(input: { sessionID: string; observation: Observation; recent: EventInfo[] }) {
    if (input.observation.kind !== "assistant_text") return [] as Finding[]
    const text = input.observation.text ?? ""
    const source = text.toLowerCase()
    if (explicitOverride(source)) return [] as Finding[]
    const asked = await latestUserText(input.sessionID)
    const intent = asked ? intentText(asked) : undefined
    const result: Finding[] = []

    const repo = await repoContext()
    const sourceFamily = familyFromSource(text)
    if (repo.family && sourceFamily && sourceFamily.id !== repo.family) {
      if (intent && familyFromSource(intent.text)?.id !== sourceFamily.id) {
        const target = families.find((item) => item.id === repo.family)
        if (target) {
          result.push(
            Finding.parse({
              fingerprint: `context:ecosystem:${repo.family}:${sourceFamily.id}`,
              severity: "medium",
              statement: `Worker output switches to ${sourceFamily.label} while project context is ${target.label}`,
              instruction: `Follow the existing ${target.label} project conventions unless user explicitly asks for a different ecosystem.`,
              confidence: 0.9,
              evidence: sourceFamily.id,
              source: "deterministic",
            }),
          )
        }
      }
    }

    if (!completionClaim(text)) return result.slice(0, 3)
    if (!intent) return result.slice(0, 3)
    const signals = sourceSignals(input.observation)
    const seen = [...signals.files.map((item) => projectPath(item)).filter((item): item is string => !!item)]
    for (const event of input.recent) {
      const info = eventSignals(event)
      seen.push(...info.files)
    }

    if (intent.paths.length > 0 && !pathEvidence({ requested: intent.paths, seen })) {
      result.push(
        Finding.parse({
          fingerprint: `context:path:${hash(intent.paths.join("|"))}`,
          severity: "medium",
          statement: `Completion claim does not include evidence in requested paths (${intent.paths.slice(0, 2).join(", ")})`,
          instruction:
            "Before marking done, modify one of the requested paths or explain the path change and confirm with the user.",
          confidence: 0.9,
          evidence: intent.paths[0],
          source: "deterministic",
        }),
      )
    }

    if (intent.wants_tests && !testEvidence({ source, seen, recent: input.recent })) {
      result.push(
        Finding.parse({
          fingerprint: `context:test:${hash(intent.text.toLowerCase())}`,
          severity: "low",
          statement: "Completion claim lacks concrete test artifact or test-run evidence for a test-requested task",
          instruction:
            "Add/update tests or run relevant test commands, then report concrete evidence (file path or command output).",
          confidence: 0.86,
          evidence: "test evidence missing",
          source: "deterministic",
        }),
      )
    }

    return result.slice(0, 3)
  }

  function policyFindings(observation: Observation, rules: Rule[]) {
    const signals = sourceSignals(observation)
    return rules
      .flatMap((rule) => {
        const policy = rulePolicy(rule)
        if (!policy) return []
        const target = stackTargets.find((item) => item.id === policy.target)
        if (!target) return []
        if (target.aliases.some((alias) => signals.source.includes(alias))) return []
        if (explicitOverride(signals.source)) return []
        const other = conflictingStack({
          source: signals.source,
          target: target.id,
        })
        const evidence = other ? (other.aliases[0] ?? other.id) : plainStack(signals)
        if (!evidence) return []
        return [
          Finding.parse({
            fingerprint: `policy:${rule.id}:${policy.intent}:${policy.target}`,
            severity: rule.severity,
            statement: rule.statement,
            instruction: `Use ${target.label} as the default stack when user did not specify one, then continue with that approach.`,
            confidence: Math.max(0.85, rule.confidence),
            rule_id: rule.id,
            evidence,
            source: "deterministic",
          }),
        ]
      })
      .slice(0, 3)
  }

  function supervisorEvidence(input: { observation: Observation; files: { file: string; text: string }[] }) {
    const source = [
      input.observation.text ?? "",
      JSON.stringify(input.observation.payload ?? {}),
      ...input.files.map((item) => item.text),
    ]
      .join("\n")
      .toLowerCase()
    return source
  }

  function absenceClaim(text: string) {
    const low = text.toLowerCase()
    return (
      low.includes("no evidence") ||
      low.includes("not invoke") ||
      low.includes("did not invoke") ||
      low.includes("didn't invoke") ||
      low.includes("not using") ||
      low.includes("missing accent") ||
      low.includes("not loaded")
    )
  }

  function evidenceMatch(input: { source: string; evidence: string }) {
    const source = input.source.toLowerCase()
    const evidence = input.evidence.toLowerCase().trim()
    if (!evidence) return false
    if (source.includes(evidence)) return true
    const stop = new Set([
      "agent",
      "assistant",
      "worker",
      "issue",
      "check",
      "state",
      "session",
      "message",
      "patch",
      "write",
      "file",
      "files",
      "tool",
      "result",
      "response",
      "project",
      "rule",
      "violation",
      "intervention",
    ])
    const tokens = evidence.split(/[^a-z0-9#./_-]+/).filter((item) => item.length >= 4 && !stop.has(item))
    if (!tokens.length) return false
    const hits = tokens.filter((item) => source.includes(item)).length
    const need = Math.min(Math.max(2, Math.ceil(tokens.length * 0.66)), 4)
    return hits >= need
  }

  function validSupervisorFinding(input: { finding: Finding; evidenceSource: string; memoryRules: Set<string> }) {
    if (input.finding.source !== "supervisor") return true
    if (input.finding.confidence < 0.78) return false
    if (!input.finding.evidence) return false
    if (!evidenceMatch({ source: input.evidenceSource, evidence: input.finding.evidence })) return false
    const key = input.finding.statement.toLowerCase().trim()
    if (input.memoryRules.has(key) && absenceClaim(input.finding.statement)) return false
    return true
  }

  function interventionConfig(cfg: z.output<typeof Config.Info>) {
    const value = cfg.aegis?.intervention
    return {
      base_holdoff_ms: value?.base_holdoff_ms ?? 90_000,
      progress_extend_ms: value?.progress_extend_ms ?? 45_000,
      max_holdoff_ms: value?.max_holdoff_ms ?? 300_000,
      stall_timeout_ms: value?.stall_timeout_ms ?? 120_000,
      contradiction_bypass: value?.contradiction_bypass ?? true,
    }
  }

  function progressTool(tool?: string) {
    if (!tool) return false
    const low = tool.toLowerCase()
    if (low === "edit" || low === "write" || low === "patch" || low === "multiedit" || low === "apply_patch")
      return true
    if (low === "bash" || low === "command") return true
    return false
  }

  function issueActivity(input: { observation: Observation; issue: IssueState }) {
    if (input.observation.kind === "patch") return true
    if (input.observation.kind === "assistant_text") return true
    if (progressTool(input.observation.tool)) return true
    const source = sourceSignals(input.observation).source
    if (input.issue.evidence && evidenceMatch({ source, evidence: input.issue.evidence })) return true
    return evidenceMatch({ source, evidence: input.issue.statement })
  }

  function contradictionSignal(input: { observation: Observation; finding: Finding }) {
    const source = sourceSignals(input.observation).source
    if (input.finding.evidence && evidenceMatch({ source, evidence: input.finding.evidence })) return true
    if (input.observation.kind !== "assistant_text") return false
    return evidenceMatch({ source, evidence: input.finding.statement })
  }

  function touchIssueProgress(input: {
    sessionID: string
    observation: Observation
    ignore_fingerprint?: string
    intervention: ReturnType<typeof interventionConfig>
  }) {
    const s = sessionSupervisor(input.sessionID)
    for (const [fingerprint, issue] of Object.entries(s.issues)) {
      if (!issue.open) continue
      issue.last_observed_at = Math.max(issue.last_observed_at, input.observation.time)
      if (fingerprint === input.ignore_fingerprint) continue
      if (!issue.last_injected_at) continue
      if (!issueActivity({ observation: input.observation, issue })) continue
      issue.last_progress_at = input.observation.time
      const cap = issue.last_injected_at + input.intervention.max_holdoff_ms
      const next = Math.min(cap, input.observation.time + input.intervention.progress_extend_ms)
      issue.holdoff_until = Math.max(issue.holdoff_until ?? 0, next)
      issue.phase = "awaiting_compliance"
      issue.suppression_reason = "progress_observed"
    }
  }

  function reinjectDecision(input: {
    issue: IssueState
    observation: Observation
    finding: Finding
    now: number
    intervention: ReturnType<typeof interventionConfig>
  }) {
    if (!input.issue.last_injected_at) {
      return {
        inject: true,
        reason: "first_injection",
        followup: false,
      }
    }
    const since = input.now - input.issue.last_injected_at
    const minGap = Math.min(30_000, input.intervention.base_holdoff_ms)
    if (
      input.intervention.contradiction_bypass &&
      since >= minGap &&
      contradictionSignal({
        observation: input.observation,
        finding: input.finding,
      })
    ) {
      return {
        inject: true,
        reason: "contradiction",
        followup: true,
      }
    }
    if ((input.issue.holdoff_until ?? 0) > input.now) {
      return {
        inject: false,
        reason: "holdoff_active",
        followup: false,
      }
    }
    const progressAt = input.issue.last_progress_at ?? input.issue.last_injected_at
    if (input.now - progressAt < input.intervention.stall_timeout_ms) {
      return {
        inject: false,
        reason: "recent_progress",
        followup: false,
      }
    }
    return {
      inject: true,
      reason: "stalled",
      followup: true,
    }
  }

  async function patchSnippets(files: string[]) {
    const picks = files.slice(0, 4)
    const chunks = await Promise.all(
      picks.map((file) =>
        Bun.file(file)
          .text()
          .then((text) => ({
            file,
            text: text.slice(0, 1400),
          }))
          .catch(() => undefined),
      ),
    )
    return chunks.filter((item) => !!item)
  }

  async function supervisorReview(input: { sessionID: string; observation: Observation; rules: Rule[] }) {
    const cfg = await Config.get()
    if (cfg.aegis?.enabled === false) {
      return {
        findings: [] as Finding[],
        resolves: [] as string[],
        model: undefined as string | undefined,
        usage: { input: 0, output: 0 },
      }
    }
    if (!shouldReview(input.observation.kind, cfg)) {
      return {
        findings: [] as Finding[],
        resolves: [] as string[],
        model: undefined as string | undefined,
        usage: { input: 0, output: 0 },
      }
    }

    const pick =
      cfg.aegis?.provider && cfg.aegis?.model
        ? {
            providerID: cfg.aegis.provider,
            modelID: cfg.aegis.model,
          }
        : await Provider.defaultModel()

    const model = await Provider.getModel(pick.providerID, pick.modelID)
    const language = await Provider.getLanguage(model)

    const files =
      input.observation.kind === "patch"
        ? await patchSnippets((input.observation.payload.files as string[] | undefined) ?? [])
        : []

    const open = Object.entries(sessionSupervisor(input.sessionID).issues)
      .filter(([, issue]) => issue.open)
      .map(([fingerprint, issue]) => ({
        fingerprint,
        severity: issue.severity,
        statement: issue.statement,
        count: issue.count,
      }))
      .slice(0, 10)

    const enforceable = input.rules
      .filter((rule) => rule.matcher.pattern || rule.matcher.tool || rule.matcher.not_pattern)
      .slice(0, 20)
    const memory = input.rules
      .filter((rule) => rule.source?.type === "memory")
      .slice(0, 20)
      .map((rule) => rule.statement)
    const body = {
      observation: {
        kind: input.observation.kind,
        tool: input.observation.tool,
        text: input.observation.text,
        payload: input.observation.payload,
      },
      patch_files: files,
      known_rules: enforceable.map((rule) => ({
        statement: rule.statement,
        severity: rule.severity,
        matcher: rule.matcher,
      })),
      project_memory: memory,
      open_issues: open,
    }

    const schema = ReviewResult
    const sys = [
      "You are Aegis, a senior engineering supervisor.",
      "Review worker-agent behavior and identify direction errors, invariant violations, and hallucination risk.",
      "Only return findings when intervention is necessary.",
      "A finding MUST cite concrete evidence from the latest observation in finding.evidence.",
      "If you cannot cite concrete evidence from the latest observation, return no findings.",
      "Do not raise violations based on missing proof or unverified absence claims.",
      "Project memory items are guidance; only raise findings when contradiction is explicit and evidenced.",
      "Use stable fingerprints so repeated issues can be tracked.",
      "If the latest signal resolves a prior issue, include that fingerprint in resolves.",
      "Do not suggest broad rewrites unless strictly necessary.",
    ].join("\n")

    const msgs: ModelMessage[] = [
      {
        role: "system",
        content: sys,
      },
      {
        role: "user",
        content: JSON.stringify(body),
      },
    ]

    const isCodex = model.providerID === "openai" && (await Auth.get(model.providerID))?.type === "oauth"

    if (isCodex) {
      const result = streamObject({
        model: language,
        schema,
        temperature: 0,
        maxOutputTokens: cfg.aegis?.max_tokens_per_check,
        messages: msgs,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      const value = schema.parse(result.object)
      const usage = ((result as any).usage ?? {}) as { inputTokens?: number; outputTokens?: number }
      const evidenceSource = supervisorEvidence({
        observation: input.observation,
        files,
      })
      const memoryRules = new Set(memory.map((item) => item.toLowerCase().trim()))
      const findings = value.findings
        .map((item) =>
          Finding.parse({
            ...item,
            source: "supervisor",
          }),
        )
        .filter((finding) =>
          validSupervisorFinding({
            finding,
            evidenceSource,
            memoryRules,
          }),
        )
      return {
        findings,
        resolves: value.resolves,
        model: `${model.providerID}/${model.id}`,
        usage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
        },
      }
    }

    const result = await generateObject({
      model: language,
      schema,
      temperature: 0,
      maxOutputTokens: cfg.aegis?.max_tokens_per_check,
      messages: msgs,
    })
    const value = schema.parse(result.object)
    const usage = ((result as any).usage ?? {}) as { inputTokens?: number; outputTokens?: number }
    const evidenceSource = supervisorEvidence({
      observation: input.observation,
      files,
    })
    const memoryRules = new Set(memory.map((item) => item.toLowerCase().trim()))
    const findings = value.findings
      .map((item) =>
        Finding.parse({
          ...item,
          source: "supervisor",
        }),
      )
      .filter((finding) =>
        validSupervisorFinding({
          finding,
          evidenceSource,
          memoryRules,
        }),
      )
    return {
      findings,
      resolves: value.resolves,
      model: `${model.providerID}/${model.id}`,
      usage: {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
      },
    }
  }

  async function latestUser(sessionID: string) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role !== "user") continue
      return item.info
    }
  }

  async function injectIntervention(input: {
    sessionID: string
    messageID: string
    partID?: string
    finding: Finding
    level: number
  }) {
    const user = await latestUser(input.sessionID)
    if (!user) return

    const note = [
      "<system-reminder>",
      `Aegis noticed a potential issue (${input.finding.severity.toUpperCase()}, L${input.level}).`,
      `Concern: ${input.finding.statement}`,
      `Suggested correction: ${input.finding.instruction}`,
      "Please verify the change with concrete evidence; if it's already satisfied, report that evidence clearly.",
      "</system-reminder>",
    ].join("\n")

    const { SessionPrompt } = await import("@/session/prompt")
    await SessionPrompt.prompt({
      sessionID: input.sessionID,
      agent: user.agent,
      model: user.model,
      variant: user.variant,
      noReply: true,
      parts: [
        {
          type: "text",
          text: note,
          synthetic: true,
        },
      ],
    })

    await recordEvent({
      sessionID: input.sessionID,
      messageID: input.messageID,
      partID: input.partID,
      ruleID: input.finding.rule_id,
      type: "intervention_injected",
      payload: {
        statement: input.finding.statement,
        instruction: input.finding.instruction,
        severity: input.finding.severity,
        level: input.level,
        fingerprint: input.finding.fingerprint,
      },
    })

    await writeState(input.sessionID, (current) => ({
      ...current,
      interventions: current.interventions + 1,
      last_intervention: {
        rule_id: input.finding.rule_id,
        fingerprint: input.finding.fingerprint,
        severity: input.finding.severity,
        level: input.level,
        time: Date.now(),
      },
    }))
  }

  async function resolveIssues(input: { sessionID: string; messageID: string; partID?: string; resolves: string[] }) {
    const s = sessionSupervisor(input.sessionID)
    for (const fingerprint of input.resolves) {
      const issue = s.issues[fingerprint]
      if (!issue) continue
      if (!issue.open) continue
      issue.open = false
      issue.holdoff_until = undefined
      issue.suppression_reason = "resolved"
      await recordEvent({
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
        type: "issue_resolved",
        payload: {
          fingerprint,
          statement: issue.statement,
          severity: issue.severity,
        },
      })
    }
  }

  async function applyFinding(input: {
    sessionID: string
    observation: Observation
    finding: Finding
    cfg: z.output<typeof Config.Info>
  }) {
    const escalation = input.cfg.aegis?.escalation
    const intervention = interventionConfig(input.cfg)
    const warningAfter = escalation?.warning_after ?? 2
    const criticalAfter = escalation?.critical_after ?? 4

    const s = sessionSupervisor(input.sessionID)
    const prev = s.issues[input.finding.fingerprint]
    const count = (prev?.count ?? 0) + 1
    const level = count >= criticalAfter ? 3 : count >= warningAfter ? 2 : 1
    const now = Date.now()

    const issue: IssueState = {
      count,
      level,
      severity: input.finding.severity,
      statement: input.finding.statement,
      instruction: input.finding.instruction,
      evidence: input.finding.evidence,
      rule_id: input.finding.rule_id,
      phase: prev?.phase ?? "open",
      time: now,
      open: true,
      followups: prev?.followups ?? 0,
      last_injected_at: prev?.last_injected_at,
      last_observed_at: now,
      last_progress_at: prev?.last_progress_at,
      holdoff_until: prev?.holdoff_until,
      suppression_reason: prev?.suppression_reason,
    }
    s.issues[input.finding.fingerprint] = issue

    await recordEvent({
      sessionID: input.sessionID,
      messageID: input.observation.messageID,
      partID: input.observation.partID,
      ruleID: input.finding.rule_id,
      type: "issue_unresolved",
      payload: {
        fingerprint: input.finding.fingerprint,
        statement: input.finding.statement,
        instruction: input.finding.instruction,
        severity: input.finding.severity,
        count,
        level,
        source: input.finding.source,
        phase: issue.phase,
        followups: issue.followups,
      },
    })

    if ((prev?.level ?? 0) !== level && level > 1) {
      await recordEvent({
        sessionID: input.sessionID,
        messageID: input.observation.messageID,
        partID: input.observation.partID,
        ruleID: input.finding.rule_id,
        type: "escalation",
        payload: {
          fingerprint: input.finding.fingerprint,
          from: prev?.level ?? 0,
          to: level,
          statement: input.finding.statement,
        },
      })
    }

    const decision = reinjectDecision({
      issue,
      observation: input.observation,
      finding: input.finding,
      now,
      intervention,
    })
    if (!decision.inject) {
      issue.phase = "awaiting_compliance"
      issue.suppression_reason = decision.reason
      await writeState(input.sessionID, (current) => ({
        ...current,
        unresolved: Object.values(s.issues).filter((item) => item.open).length,
        last_violation: {
          rule_id: input.finding.rule_id,
          statement: input.finding.statement,
          severity: input.finding.severity,
          source: input.finding.source,
          kind: input.observation.kind,
          time: now,
        },
      }))
      return {
        injected: false,
        reason: decision.reason,
      }
    }

    const followups = decision.followup ? issue.followups + 1 : issue.followups
    const holdoff = Math.min(intervention.base_holdoff_ms * (followups + 1), intervention.max_holdoff_ms)
    issue.followups = followups
    issue.last_injected_at = now
    issue.last_progress_at = now
    issue.holdoff_until = now + holdoff
    issue.phase = "awaiting_compliance"
    issue.suppression_reason = decision.reason

    await injectIntervention({
      sessionID: input.sessionID,
      messageID: input.observation.messageID,
      partID: input.observation.partID,
      finding: input.finding,
      level,
    })
    s.injected[input.finding.fingerprint] = now

    await writeState(input.sessionID, (current) => ({
      ...current,
      unresolved: Object.values(s.issues).filter((item) => item.open).length,
      last_violation: {
        rule_id: input.finding.rule_id,
        statement: input.finding.statement,
        severity: input.finding.severity,
        source: input.finding.source,
        kind: input.observation.kind,
        time: now,
      },
    }))

    return {
      injected: true,
      reason: decision.reason,
    }
  }

  async function processObservation(input: { sessionID: string; observation: Observation }) {
    const obs = input.observation
    const s = sessionSupervisor(input.sessionID)
    await recordEvent({
      sessionID: input.sessionID,
      messageID: obs.messageID,
      partID: obs.partID,
      type: "check_started",
      payload: {
        kind: obs.kind,
        tool: obs.tool,
      },
    })

    const cfg = await Config.get()
    const intervention = interventionConfig(cfg)
    const rules = await activeRules()
    const recent = await events(input.sessionID, 80)
    const context = await contextFindings({
      sessionID: input.sessionID,
      observation: obs,
      recent,
    })
    const deterministic = [...deterministicFindings(obs, rules), ...policyFindings(obs, rules), ...context]
    const review = await supervisorReview({
      sessionID: input.sessionID,
      observation: obs,
      rules,
    }).catch((error) => {
      log.error("aegis supervisor review failed", {
        error,
        kind: obs.kind,
      })
      return {
        findings: [] as Finding[],
        resolves: [] as string[],
        model: undefined as string | undefined,
        usage: { input: 0, output: 0 },
      }
    })

    await resolveIssues({
      sessionID: input.sessionID,
      messageID: obs.messageID,
      partID: obs.partID,
      resolves: review.resolves,
    })

    const merged = [...deterministic, ...review.findings]
    const top = merged
      .toSorted((a, b) => {
        const severity = severityScore(b.severity) - severityScore(a.severity)
        if (severity !== 0) return severity
        return b.confidence - a.confidence
      })
      .at(0)
    const repeatSupervisor =
      top && top.source === "supervisor" && obs.kind !== "assistant_text" && !!s.issues[top.fingerprint]?.open

    touchIssueProgress({
      sessionID: input.sessionID,
      observation: obs,
      ignore_fingerprint: top?.fingerprint,
      intervention,
    })

    let injected = false
    let suppressReason: string | undefined
    if (top && !repeatSupervisor) {
      await recordEvent({
        sessionID: input.sessionID,
        messageID: obs.messageID,
        partID: obs.partID,
        ruleID: top.rule_id,
        type: "violation",
        payload: {
          statement: top.statement,
          severity: top.severity,
          source: top.source,
          kind: obs.kind,
          fingerprint: top.fingerprint,
        },
      })
      const result = await applyFinding({
        sessionID: input.sessionID,
        observation: obs,
        finding: top,
        cfg,
      })
      injected = result.injected
      suppressReason = result.reason
    }

    await recordEvent({
      sessionID: input.sessionID,
      messageID: obs.messageID,
      partID: obs.partID,
      ruleID: top?.rule_id,
      type: "check_completed",
      payload: {
        kind: obs.kind,
        intervene: injected,
        findings: merged.length,
        suppressed_reason: !injected && top && !repeatSupervisor ? suppressReason : undefined,
        model: review.model,
      },
    })

    await writeState(input.sessionID, (current) => ({
      ...current,
      checks: current.checks + 1,
      unresolved: Object.values(s.issues).filter((item) => item.open).length,
      model: review.model ?? current.model,
      tokens: {
        input: current.tokens.input + review.usage.input,
        output: current.tokens.output + review.usage.output,
      },
    }))
  }

  async function processQueue(sessionID: string) {
    const s = sessionSupervisor(sessionID)
    if (s.processing) return
    s.processing = true

    while (s.queue.length > 0) {
      if (s.paused) break
      const observation = s.queue.shift()!
      await writeState(sessionID, (current) => ({
        ...current,
        queue: s.queue.length,
      }))
      await processObservation({
        sessionID,
        observation,
      })
    }

    s.processing = false
  }

  async function enqueue(observation: Observation) {
    await ensureBootstrapped()
    const cfg = await Config.get()
    if (cfg.aegis?.enabled === false) return

    const s = sessionSupervisor(observation.sessionID)
    s.queue.push(observation)
    await writeState(observation.sessionID, (current) => ({
      ...current,
      status: s.paused ? "paused" : "running",
      queue: s.queue.length,
    }))
    processQueue(observation.sessionID).catch((error) => {
      log.error("aegis queue processing failed", { error })
    })
  }

  async function workspaceSessionRows() {
    return Database.use((db) =>
      db
        .select({
          id: SessionTable.id,
          title: SessionTable.title,
          updated: SessionTable.time_updated,
        })
        .from(SessionTable)
        .where(eq(SessionTable.project_id, Instance.project.id))
        .all(),
    )
  }

  async function workspaceEventRows(input: {
    sessionIDs: string[]
    limit?: number
    cursor?: number
    since?: number
    types?: EventType[]
  }) {
    if (!input.sessionIDs.length) return []
    return Database.use((db) =>
      db
        .select()
        .from(AegisEventTable)
        .where(
          and(
            inArray(AegisEventTable.session_id, input.sessionIDs),
            input.cursor ? lt(AegisEventTable.time_created, input.cursor) : undefined,
            input.since ? gte(AegisEventTable.time_created, input.since) : undefined,
            input.types?.length ? inArray(AegisEventTable.type, input.types) : undefined,
          ),
        )
        .orderBy(desc(AegisEventTable.time_created))
        .limit(input.limit ?? 5000)
        .all(),
    )
  }

  async function feedbackStats(input: { sessionIDs: string[]; since: number }) {
    const byRule = new Map<string, FeedbackAgg>()
    const byFingerprint = new Map<string, FeedbackAgg>()
    const byPair = new Map<string, FeedbackAgg>()
    const rows = await workspaceEventRows({
      sessionIDs: input.sessionIDs,
      since: input.since,
      types: ["feedback"],
      limit: 5000,
    })
    for (const row of rows) {
      const event = toEvent(row)
      const helpful = typeof event.payload.helpful === "boolean" ? event.payload.helpful : undefined
      if (helpful === undefined) continue
      const fingerprint = payloadText(event.payload, "fingerprint")
      const rule = payloadText(event.payload, "rule_id") ?? event.rule_id
      feedbackAcc({
        map: byRule,
        key: rule,
        helpful,
        time: event.time.created,
      })
      feedbackAcc({
        map: byFingerprint,
        key: fingerprint,
        helpful,
        time: event.time.created,
      })
      feedbackAcc({
        map: byPair,
        key: fingerprint && rule ? `${fingerprint}::${rule}` : undefined,
        helpful,
        time: event.time.created,
      })
    }
    return {
      byRule,
      byFingerprint,
      byPair,
    }
  }

  function nowState(input: { items: Thread[]; sessions: Array<{ id: string; title: string; updated: number }> }) {
    const latest = input.sessions[0]
    const unresolved = input.items.filter((item) => item.status !== "resolved")
    const active = unresolved.find((item) => item.status === "open" || item.status === "noisy")
    if (active) {
      return Now.parse({
        state: "intervening",
        session_id: active.session_id,
        session_title: latest?.title,
        updated: Date.now(),
      })
    }
    if (unresolved.some((item) => item.compliance.verdict === "unknown")) {
      return Now.parse({
        state: "waiting_on_user_policy",
        session_id: unresolved[0]?.session_id,
        session_title: latest?.title,
        updated: Date.now(),
      })
    }
    if (unresolved.length > 0) {
      return Now.parse({
        state: "waiting_on_worker",
        session_id: unresolved[0]?.session_id,
        session_title: latest?.title,
        updated: Date.now(),
      })
    }
    return Now.parse({
      state: "watching",
      session_id: latest?.id,
      session_title: latest?.title,
      updated: Date.now(),
    })
  }

  export async function snapshot(sessionID: string): Promise<Snapshot> {
    await ensureBootstrapped()
    return {
      state: await currentState(sessionID),
      events: await events(sessionID, 50),
    }
  }

  export async function events(sessionID: string, limit = 50): Promise<EventInfo[]> {
    return Database.use((db) =>
      db
        .select()
        .from(AegisEventTable)
        .where(eq(AegisEventTable.session_id, sessionID))
        .orderBy(desc(AegisEventTable.time_created))
        .limit(limit)
        .all(),
    )
      .map(toEvent)
      .toReversed()
  }

  export async function metrics(sessionID: string): Promise<Metrics> {
    const item = await currentState(sessionID)
    return {
      session_id: item.session_id,
      mode: item.mode,
      status: item.status,
      queue: item.queue,
      checks: item.checks,
      interventions: item.interventions,
      unresolved: item.unresolved,
      model: item.model,
      tokens: item.tokens,
    }
  }

  export async function workspace(limit = 50): Promise<Workspace> {
    await ensureBootstrapped()
    const cfg = await Config.get()
    const totals = await countRules()
    const allRules = Database.use((db) =>
      db
        .select()
        .from(AegisRuleTable)
        .where(
          sql`${AegisRuleTable.scope} = 'global' OR (${AegisRuleTable.scope} = 'project' AND ${AegisRuleTable.project_id} = ${Instance.project.id})`,
        )
        .orderBy(desc(AegisRuleTable.time_updated))
        .all(),
    ).map(toRule)
    const sessions = await workspaceSessionRows()
    const ids = sessions.map((item) => item.id)
    const sessionRows = ids.length
      ? Database.use((db) =>
          db.select().from(AegisSessionTable).where(inArray(AegisSessionTable.session_id, ids)).all(),
        )
      : []
    const bySession = new Map(
      sessionRows.map((item) => [item.session_id, normalizeState(item.state, item.session_id, totals)]),
    )
    const summaries = sessions
      .map((item) => {
        const state = bySession.get(item.id) ?? normalizeState({}, item.id, totals)
        return WorkspaceSession.parse({
          session_id: item.id,
          title: item.title,
          updated: item.updated,
          mode: state.mode,
          status: state.status,
          queue: state.queue,
          checks: state.checks,
          unresolved: state.unresolved,
          interventions: state.interventions,
          model: state.model,
          tokens: state.tokens,
          last_violation: state.last_violation,
          last_intervention: state.last_intervention,
        })
      })
      .toSorted((a, b) => b.updated - a.updated)
    const interventions = ids.length
      ? Database.use((db) =>
          db
            .select()
            .from(AegisEventTable)
            .where(
              and(
                inArray(AegisEventTable.session_id, ids),
                inArray(AegisEventTable.type, ["intervention_injected", "violation", "escalation"]),
              ),
            )
            .orderBy(desc(AegisEventTable.time_created))
            .limit(limit)
            .all(),
        )
      : []
    const feedback = await feedbackStats({
      sessionIDs: ids,
      since: Date.now() - 7 * 24 * 60 * 60 * 1000,
    })
    const feedbackMap = Object.fromEntries(
      Array.from(feedback.byRule.entries()).map(([id, info]) => [
        id,
        RuleFeedback.parse({
          score_7d: info.score,
          count_7d: info.count,
          last_feedback: info.last,
        }),
      ]),
    )
    return {
      supervisor: {
        provider: cfg.aegis?.provider,
        model: cfg.aegis?.model,
        configured: Boolean(cfg.aegis?.provider && cfg.aegis?.model),
      },
      rules: {
        global: allRules.filter((item) => item.scope === "global"),
        project: allRules.filter((item) => item.scope === "project"),
        active: totals.active,
        total: allRules.length,
        feedback_7d: feedbackMap,
      },
      sessions: summaries,
      interventions: interventions.map(toEvent).toReversed(),
    }
  }

  export async function workspaceEvents(input: z.input<typeof WorkspaceEventsInput>): Promise<WorkspaceEvents> {
    await ensureBootstrapped()
    const value = WorkspaceEventsInput.parse(input)
    const sessions = await workspaceSessionRows()
    const ids = sessions.map((item) => item.id)
    if (!ids.length) return { items: [], next_cursor: undefined }

    const rows = await workspaceEventRows({
      sessionIDs: ids,
      cursor: value.cursor,
      limit: value.limit + 1,
    })
    const more = rows.length > value.limit
    const slice = more ? rows.slice(0, value.limit) : rows
    return {
      items: slice.map(toEvent).toReversed(),
      next_cursor: more ? slice.at(-1)?.time_created : undefined,
    }
  }

  export async function workspaceThreads(input: z.input<typeof WorkspaceThreadsInput>): Promise<WorkspaceThreads> {
    await ensureBootstrapped()
    const value = WorkspaceThreadsInput.parse(input)
    const sessions = await workspaceSessionRows()
    const ids = sessions.map((item) => item.id)
    if (!ids.length) {
      return {
        items: [],
        now: Now.parse({
          state: "watching",
          updated: Date.now(),
        }),
        total: 0,
      }
    }

    const since = Date.now() - value.window_ms
    const rows = await workspaceEventRows({
      sessionIDs: value.session_id ? [value.session_id] : ids,
      since,
      limit: 8000,
    })
    const events = rows.map(toEvent).toReversed()
    const bySession = new Map<string, EventInfo[]>()
    for (const event of events) {
      const list = bySession.get(event.session_id) ?? []
      list.push(event)
      bySession.set(event.session_id, list)
    }

    const feedback = await feedbackStats({
      sessionIDs: value.session_id ? [value.session_id] : ids,
      since: Date.now() - 7 * 24 * 60 * 60 * 1000,
    })
    const issue = new Map<
      string,
      {
        open: boolean
        level: number
        severity: RuleSeverity
        instruction?: string
      }
    >()
    for (const event of events) {
      const fingerprint = payloadFingerprint(event.payload)
      if (!fingerprint) continue
      const key = `${event.session_id}::${fingerprint}`
      const prev = issue.get(key) ?? {
        open: false,
        level: 1,
        severity: "medium" as RuleSeverity,
        instruction: undefined,
      }
      if (event.type === "issue_unresolved") {
        issue.set(key, {
          open: true,
          level: payloadNum(event.payload, "level", prev.level),
          severity: payloadSeverity(event.payload),
          instruction: payloadText(event.payload, "instruction") ?? prev.instruction,
        })
        continue
      }
      if (event.type === "issue_resolved") {
        issue.set(key, {
          ...prev,
          open: false,
        })
        continue
      }
      if (event.type === "escalation") {
        issue.set(key, {
          ...prev,
          open: true,
          level: payloadNum(event.payload, "to", prev.level),
        })
        continue
      }
      if (event.type === "intervention_injected") {
        issue.set(key, {
          ...prev,
          instruction: payloadText(event.payload, "instruction") ?? prev.instruction,
        })
      }
    }

    const groups = new Map<
      string,
      {
        event_id: string
        session_id: string
        type: string
        fingerprint: string
        statement: string
        severity: RuleSeverity
        level: number
        count: number
        first_seen: number
        last_seen: number
        rule_id?: string
        last_supervisor_message?: string
      }
    >()
    const kindRank = {
      violation: 1,
      escalation: 2,
      intervention_injected: 3,
    } as const
    for (const event of events) {
      const fingerprint = payloadFingerprint(event.payload)
      if (!fingerprint) continue
      if (event.type !== "violation" && event.type !== "intervention_injected" && event.type !== "escalation") continue
      const key = `${fingerprint}::${event.session_id}`
      const prev = groups.get(key)
      const statement = summarizeEvent(event)
      const severity = payloadSeverity(event.payload)
      const level = payloadNum(event.payload, "level", payloadNum(event.payload, "to", prev?.level ?? 1))
      const instruction = payloadText(event.payload, "instruction")
      if (!prev) {
        groups.set(key, {
          event_id: event.id,
          session_id: event.session_id,
          type: event.type,
          fingerprint,
          statement,
          severity,
          level,
          count: 1,
          first_seen: event.time.created,
          last_seen: event.time.created,
          rule_id: event.rule_id,
          last_supervisor_message: instruction,
        })
        continue
      }
      const pickType = kindRank[event.type] > kindRank[prev.type as keyof typeof kindRank]
      const sameType = prev.type === event.type
      const nextSeverity = severityScore(severity) >= severityScore(prev.severity) ? severity : prev.severity
      groups.set(key, {
        ...prev,
        event_id: pickType || sameType ? event.id : prev.event_id,
        type: pickType ? event.type : prev.type,
        statement: pickType || sameType ? statement : prev.statement,
        severity: nextSeverity,
        level: Math.max(level, prev.level),
        count: prev.count + 1,
        last_seen: event.time.created,
        first_seen: Math.min(prev.first_seen, event.time.created),
        rule_id: pickType || sameType ? (event.rule_id ?? prev.rule_id) : prev.rule_id,
        last_supervisor_message: instruction ?? prev.last_supervisor_message,
      })
    }

    const scored = Array.from(groups.entries()).map(([key, item]) => {
      const fingerprintKey = `${item.session_id}::${item.fingerprint}`
      const state = issue.get(fingerprintKey) ?? {
        open: false,
        level: item.level,
        severity: item.severity,
      }
      const sessionEvents = bySession.get(item.session_id) ?? []
      const compliance = complianceFrom({
        events: sessionEvents,
        fingerprint: item.fingerprint,
      })
      const pair = item.rule_id ? feedback.byPair.get(`${item.fingerprint}::${item.rule_id}`) : undefined
      const fp = feedback.byFingerprint.get(item.fingerprint)
      const helpfulness = pair ?? fp
      const helpfulnessScore = helpfulness?.score ?? 0
      const feedbackCount = helpfulness?.count ?? 0
      const status = (() => {
        if (!state.open) return "resolved" as const
        if (
          item.count >= 3 &&
          helpfulnessScore <= -2 &&
          (compliance.verdict === "ignored" || compliance.verdict === "unclear" || compliance.verdict === "unknown")
        ) {
          return "noisy" as const
        }
        if (state.level >= 2 || state.severity === "high") return "open" as const
        return "watching" as const
      })()
      return Thread.parse({
        ...item,
        key,
        level: Math.max(item.level, state.level),
        severity: state.severity,
        status,
        last_supervisor_message: item.last_supervisor_message ?? state.instruction,
        helpfulness_score_7d: helpfulnessScore,
        feedback_count_7d: feedbackCount,
        compliance,
      })
    })

    const filtered = scored.filter((item) => {
      if (value.session_id && value.session_id !== item.session_id) return false
      if (value.status && value.status !== item.status) return false
      if (value.severity && value.severity !== item.severity) return false
      if (value.type && value.type !== item.type) return false
      if (value.preset === "active_fire" && !(item.status === "open" || item.status === "noisy")) return false
      if (value.preset === "new_regressions" && item.first_seen < Date.now() - 2 * 60 * 60 * 1000) return false
      if (value.preset === "noisy_rules" && !(item.status === "noisy" || item.helpfulness_score_7d <= -2)) return false
      if (
        value.preset === "supervisor_struggling" &&
        !(
          item.count >= 3 &&
          item.level >= 2 &&
          (item.compliance.verdict === "ignored" || item.compliance.verdict === "unclear")
        )
      ) {
        return false
      }
      return true
    })

    const sorted = filtered.toSorted((a, b) => {
      const status =
        (a.status === "noisy" ? 4 : a.status === "open" ? 3 : a.status === "watching" ? 2 : 1) -
        (b.status === "noisy" ? 4 : b.status === "open" ? 3 : b.status === "watching" ? 2 : 1)
      if (status !== 0) return -status
      const severity = severityScore(a.severity) - severityScore(b.severity)
      if (severity !== 0) return -severity
      return b.last_seen - a.last_seen
    })
    const slices = sorted.slice(0, value.limit)
    return {
      items: slices,
      now: nowState({
        items: slices,
        sessions: sessions.toSorted((a, b) => b.updated - a.updated),
      }),
      total: sorted.length,
    }
  }

  export async function control(input: z.input<typeof ControlInput>) {
    const value = ControlInput.parse(input)
    const s = sessionSupervisor(value.sessionID)
    s.paused = value.action === "pause"
    const result = await writeState(value.sessionID, (current) => ({
      ...current,
      status: s.paused ? "paused" : "running",
      queue: s.queue.length,
    }))
    if (!s.paused) {
      processQueue(value.sessionID).catch((error) => {
        log.error("aegis queue processing failed", { error })
      })
    }
    return result
  }

  async function editableRule(ruleID: string) {
    const row = Database.use((db) => db.select().from(AegisRuleTable).where(eq(AegisRuleTable.id, ruleID)).get())
    if (!row) return
    if (row.scope === "project" && row.project_id !== Instance.project.id) return
    return row
  }

  async function runDry(input: z.input<typeof DryRunInput>) {
    const value = DryRunInput.parse(input)
    const sessions = await workspaceSessionRows()
    const ids = (value.sessionID ? sessions.filter((item) => item.id === value.sessionID) : sessions).map(
      (item) => item.id,
    )
    if (!ids.length) return DryRunResult.parse({ matched: 0, examples: [] })
    const rows = await workspaceEventRows({
      sessionIDs: ids,
      since: Date.now() - value.window_ms,
      limit: 8000,
    })
    const events = rows.map(toEvent).toReversed()
    const policy = normalizePolicy(value.matcher.policy)
    const matches = events.filter((event) => {
      const tool = payloadText(event.payload, "tool")
      const matcherMatch = (() => {
        const low = JSON.stringify(event.payload).toLowerCase()
        if (value.matcher.tool && value.matcher.tool !== "*" && tool !== value.matcher.tool) return false
        if (!value.matcher.pattern) return false
        if (!contains(low, value.matcher.pattern)) return false
        if (value.matcher.not_pattern && contains(low, value.matcher.not_pattern)) return false
        return true
      })()
      const policyMatch = (() => {
        if (!policy) return false
        const observation = (() => {
          if (event.type === "observe_text") {
            return Observation.parse({
              id: event.id,
              sessionID: event.session_id,
              messageID: event.message_id ?? "",
              partID: event.part_id,
              kind: "assistant_text",
              text: payloadText(event.payload, "text"),
              payload: event.payload,
              time: event.time.created,
            })
          }
          if (event.type === "observe_patch") {
            return Observation.parse({
              id: event.id,
              sessionID: event.session_id,
              messageID: event.message_id ?? "",
              partID: event.part_id,
              kind: "patch",
              payload: event.payload,
              time: event.time.created,
            })
          }
          if (event.type === "observe_tool_call") {
            return Observation.parse({
              id: event.id,
              sessionID: event.session_id,
              messageID: event.message_id ?? "",
              partID: event.part_id,
              kind: "tool_call",
              tool,
              payload: (event.payload.input as Record<string, unknown> | undefined) ?? {},
              time: event.time.created,
            })
          }
          if (event.type === "observe_tool_result") {
            return Observation.parse({
              id: event.id,
              sessionID: event.session_id,
              messageID: event.message_id ?? "",
              partID: event.part_id,
              kind: "tool_result",
              tool,
              payload: (event.payload.output as Record<string, unknown> | undefined) ?? {},
              time: event.time.created,
            })
          }
        })()
        if (!observation) return false
        const target = stackTargets.find((item) => item.id === policy.target)
        if (!target) return false
        const signals = sourceSignals(observation)
        if (target.aliases.some((alias) => signals.source.includes(alias))) return false
        if (explicitOverride(signals.source)) return false
        const other = conflictingStack({
          source: signals.source,
          target: target.id,
        })
        return !!(other ? (other.aliases[0] ?? other.id) : plainStack(signals))
      })()
      return matcherMatch || policyMatch
    })
    return DryRunResult.parse({
      matched: matches.length,
      examples: matches.slice(0, value.limit_examples).map((event) => ({
        event_id: event.id,
        session_id: event.session_id,
        type: event.type,
        time: event.time.created,
        summary: summarizeEvent(event),
      })),
    })
  }

  export const updateRule = async (input: z.input<typeof RuleUpdateInput>) => {
    const value = RuleUpdateInput.parse(input)
    const row = await editableRule(value.ruleID)
    if (!row) throw new Error("Rule not found")
    if (row.scope === "global" && !value.confirm_global) {
      throw new Error("Global rule edits require confirm_global=true")
    }

    const next = {
      statement: value.statement ?? row.statement,
      matcher: value.matcher ?? row.matcher,
      severity: value.severity ?? row.severity,
      active: value.active === undefined ? row.active : value.active ? 1 : 0,
    }
    Database.use((db) => db.update(AegisRuleTable).set(next).where(eq(AegisRuleTable.id, value.ruleID)).run())
    const updated = Database.use((db) =>
      db.select().from(AegisRuleTable).where(eq(AegisRuleTable.id, value.ruleID)).get(),
    )
    if (!updated) throw new Error("Failed to update rule")
    const info = toRule(updated)
    await Bus.publish(Event.RuleUpdated, {
      rule: info,
    })
    if (value.sessionID) {
      await recordEvent({
        sessionID: value.sessionID,
        ruleID: value.ruleID,
        type: "rule_updated",
        payload: {
          statement: info.statement,
          matcher: info.matcher,
          severity: info.severity,
          active: info.active,
        },
      })
    }
    return info
  }

  export const deleteRule = async (input: z.input<typeof RuleDeleteInput>) => {
    const value = RuleDeleteInput.parse(input)
    const row = await editableRule(value.ruleID)
    if (!row) throw new Error("Rule not found")
    if (row.scope === "global" && !value.confirm_global) {
      throw new Error("Global rule deletes require confirm_global=true")
    }
    Database.use((db) =>
      db
        .update(AegisRuleTable)
        .set({
          active: 0,
        })
        .where(eq(AegisRuleTable.id, value.ruleID))
        .run(),
    )
    const updated = Database.use((db) =>
      db.select().from(AegisRuleTable).where(eq(AegisRuleTable.id, value.ruleID)).get(),
    )
    if (!updated) throw new Error("Failed to delete rule")
    const info = toRule(updated)
    await Bus.publish(Event.RuleUpdated, {
      rule: info,
    })
    if (value.sessionID) {
      await recordEvent({
        sessionID: value.sessionID,
        ruleID: value.ruleID,
        type: "rule_deleted",
        payload: {
          statement: info.statement,
          scope: info.scope,
        },
      })
    }
    return info
  }

  export const dryRunRule = async (input: z.input<typeof DryRunInput>) => {
    await ensureBootstrapped()
    return runDry(input)
  }

  export const override = async (input: z.input<typeof OverrideInput>) => {
    const value = OverrideInput.parse(input)
    await ensureBootstrapped()
    const rule = await createRule({
      scope: value.scope,
      projectID: value.scope === "project" ? Instance.project.id : undefined,
      kind: "explicit",
      statement: value.statement,
      matcher: value.matcher,
      severity: value.severity,
      confidence: 1,
      active: value.active,
      source: {
        type: "override",
        value: value.scope,
      },
    })

    if (value.sessionID) {
      await recordEvent({
        sessionID: value.sessionID,
        ruleID: rule.id,
        type: "override",
        payload: {
          statement: rule.statement,
          scope: rule.scope,
        },
      })
      await writeState(value.sessionID, (current) => current)
    }

    return rule
  }

  export const overrideDryRun = async (input: z.input<typeof DryRunInput>) => {
    await ensureBootstrapped()
    return runDry(input)
  }

  export const feedback = async (input: z.input<typeof FeedbackInput>) => {
    const value = FeedbackInput.parse(input)
    const eventRow = Database.use((db) =>
      db.select().from(AegisEventTable).where(eq(AegisEventTable.id, value.eventID)).get(),
    )
    if (!eventRow) return false

    const payload = {
      ...eventRow.payload,
      feedback: {
        helpful: value.helpful,
        note: value.note,
        time: Date.now(),
      },
    }

    Database.use((db) =>
      db
        .update(AegisEventTable)
        .set({
          payload,
        })
        .where(eq(AegisEventTable.id, value.eventID))
        .run(),
    )

    const ruleID = value.rule_id ?? eventRow.rule_id ?? undefined
    const rule = ruleID
      ? Database.use((db) => db.select().from(AegisRuleTable).where(eq(AegisRuleTable.id, ruleID)).get())
      : undefined

    if (rule && rule.kind !== "explicit") {
      const next = Math.max(0, Math.min(100, rule.confidence + (value.helpful ? 5 : -10)))
      Database.use((db) =>
        db.update(AegisRuleTable).set({ confidence: next }).where(eq(AegisRuleTable.id, rule.id)).run(),
      )
      const updated = Database.use((db) => db.select().from(AegisRuleTable).where(eq(AegisRuleTable.id, rule.id)).get())
      if (updated) {
        await Bus.publish(Event.RuleUpdated, {
          rule: toRule(updated),
        })
      }
    }

    await recordEvent({
      sessionID: value.sessionID ?? eventRow.session_id,
      messageID: eventRow.message_id ?? undefined,
      partID: eventRow.part_id ?? undefined,
      ruleID,
      type: "feedback",
      payload: {
        helpful: value.helpful,
        note: value.note,
        fingerprint: value.fingerprint ?? payloadFingerprint(eventRow.payload),
        rule_id: ruleID,
      },
    })

    return true
  }

  export const observeToolCall = async (input: z.input<typeof ObserveInput>) => {
    const value = ObserveInput.parse(input)
    await ensureBootstrapped()
    mineHistory(value.sessionID).catch((error) => {
      log.warn("history miner failed", { error })
    })

    await recordEvent({
      sessionID: value.sessionID,
      messageID: value.messageID,
      partID: value.partID,
      type: "observe_tool_call",
      payload: {
        tool: value.tool,
        input: value.input,
      },
    })

    await enqueue({
      id: ulid(),
      sessionID: value.sessionID,
      messageID: value.messageID,
      partID: value.partID,
      kind: "tool_call",
      tool: value.tool,
      payload: value.input,
      time: Date.now(),
    })
  }

  export const observeToolResult = async (input: z.input<typeof ObserveResultInput>) => {
    const value = ObserveResultInput.parse(input)
    await ensureBootstrapped()

    await recordEvent({
      sessionID: value.sessionID,
      messageID: value.messageID,
      partID: value.partID,
      type: "observe_tool_result",
      payload: {
        tool: value.tool,
        output: value.output,
      },
    })

    await enqueue({
      id: ulid(),
      sessionID: value.sessionID,
      messageID: value.messageID,
      partID: value.partID,
      kind: "tool_result",
      tool: value.tool,
      payload: value.output,
      time: Date.now(),
    })
  }

  export const observePatch = async (input: z.input<typeof ObservePatchInput>) => {
    const value = ObservePatchInput.parse(input)
    await ensureBootstrapped()

    await recordEvent({
      sessionID: value.sessionID,
      messageID: value.messageID,
      partID: value.partID,
      type: "observe_patch",
      payload: {
        files: value.files,
      },
    })

    await enqueue({
      id: ulid(),
      sessionID: value.sessionID,
      messageID: value.messageID,
      partID: value.partID,
      kind: "patch",
      payload: {
        files: value.files,
      },
      time: Date.now(),
    })
  }

  export const observeText = async (input: z.input<typeof ObserveTextInput>) => {
    const value = ObserveTextInput.parse(input)
    await ensureBootstrapped()

    const mined = await memoryMine({
      role: value.role,
      text: value.text,
    }).catch((error) => {
      log.warn("aegis memory tool failed", { error })
      return [] as Array<{ statement: string; scope: RuleScope; confidence: number; policy?: Policy }>
    })
    const fallback = memoryText(value.role, value.text).map((statement) => ({
      statement,
      scope: memoryScope(statement),
      confidence: value.role === "user" ? 1 : 0.7,
      policy: statementPolicy(statement),
    }))
    const picks = (mined.length > 0 ? mined : fallback)
      .filter((item) => item.statement.length >= 6)
      .filter((item) =>
        value.role === "assistant"
          ? !ephemeralAssistantMemory(item.statement) && (durableAssistantMemory(item.statement) || !!item.policy)
          : true,
      )
      .slice(0, 5)
    const seen = new Set<string>()
    for (const item of picks) {
      const key = `${item.scope}:${item.statement.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      const rule = await createRule({
        scope: item.scope,
        projectID: item.scope === "project" ? Instance.project.id : undefined,
        kind: value.role === "user" ? "explicit" : "runtime",
        statement: item.statement,
        matcher: item.policy ? { policy: item.policy } : {},
        severity: value.role === "user" ? "high" : "medium",
        confidence: value.role === "user" ? 1 : item.confidence,
        source: {
          type: "memory",
          value: mined.length > 0 ? "memory-tool" : value.role,
        },
      })
      const exists = Database.use((db) =>
        db
          .select({ id: AegisEventTable.id })
          .from(AegisEventTable)
          .where(
            and(
              eq(AegisEventTable.session_id, value.sessionID),
              eq(AegisEventTable.type, "memory"),
              eq(AegisEventTable.rule_id, rule.id),
            ),
          )
          .get(),
      )
      if (!exists) {
        await recordEvent({
          sessionID: value.sessionID,
          messageID: value.messageID,
          partID: value.partID,
          ruleID: rule.id,
          type: "memory",
          payload: {
            statement: rule.statement,
            role: value.role,
            scope: rule.scope,
            method: mined.length > 0 ? "tool" : "pattern",
          },
        })
      }
    }

    if (value.role !== "assistant") return

    await recordEvent({
      sessionID: value.sessionID,
      messageID: value.messageID,
      partID: value.partID,
      type: "observe_text",
      payload: {
        role: value.role,
        text: value.text,
      },
    })

    await enqueue({
      id: ulid(),
      sessionID: value.sessionID,
      messageID: value.messageID,
      partID: value.partID,
      kind: "assistant_text",
      text: value.text,
      payload: {
        role: value.role,
      },
      time: Date.now(),
    })
  }
}
