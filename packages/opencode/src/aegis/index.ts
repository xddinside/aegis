import { and, desc, eq, inArray, isNull, lt, sql } from "@/storage/db"
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

  export const Matcher = z
    .object({
      tool: z.string().optional(),
      pattern: z.string().optional(),
      not_pattern: z.string().optional(),
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
      }),
    ),
    resolves: z.array(z.string()).default([]),
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
  })

  export const ControlInput = z.object({
    sessionID: z.string(),
    action: z.enum(["pause", "resume"]),
  })

  export const WorkspaceEventsInput = z.object({
    limit: z.number().int().positive().max(200).default(100),
    cursor: z.number().int().positive().optional(),
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

  const state = Instance.state(() => {
    return {
      bootstrapped: false,
      mining: new Set<string>(),
      supervisor: {} as Record<
        string,
        {
          queue: Observation[]
          processing: boolean
          paused: boolean
          issues: Record<
            string,
            {
              count: number
              level: number
              severity: RuleSeverity
              statement: string
              time: number
              open: boolean
            }
          >
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
      for (const item of line.matchAll(/\b(?:remember|note|store|keep in mind)\b[^:]*[:,-]?\s*(.+)/gi)) {
        const value = clean(item[1] ?? "")
        if (value) result.push(value)
      }
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
      if (role === "assistant" && /^(?:i(?:'ll| will)|we(?:'ll| will))\s+/.test(low) && low.includes("project")) {
        result.push(line)
      }
    }

    return Array.from(new Set(result.map(clean))).filter((line) => line.length >= 6 && line.length <= 180).slice(0, 5)
  }

  function normalizeState(input: Partial<SessionState>, sessionID: string, rules: { global: number; project: number; active: number }) {
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
    const row = Database.use((db) => db.select().from(AegisSessionTable).where(eq(AegisSessionTable.session_id, sessionID)).get())
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
            input.scope === "project" ? eq(AegisRuleTable.project_id, input.projectID ?? "") : isNull(AegisRuleTable.project_id),
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
          project_id: input.scope === "project" ? input.projectID ?? null : null,
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
      const weight = (a.scope === "project" ? 10 : 0) + (a.kind === "explicit" ? 10 : 0) + (a.kind === "runtime" ? 2 : 0)
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
        : {}) ??
        {}),
      ...((root.devDependencies && typeof root.devDependencies === "object"
        ? (root.devDependencies as Record<string, unknown>)
        : {}) ??
        {}),
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
          source: "deterministic",
        })
      })
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

    const pick = cfg.aegis?.provider && cfg.aegis?.model
      ? {
          providerID: cfg.aegis.provider,
          modelID: cfg.aegis.model,
        }
      : await Provider.defaultModel()

    const model = await Provider.getModel(pick.providerID, pick.modelID)
    const language = await Provider.getLanguage(model)

    const files = input.observation.kind === "patch"
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

    const body = {
      observation: {
        kind: input.observation.kind,
        tool: input.observation.tool,
        text: input.observation.text,
        payload: input.observation.payload,
      },
      patch_files: files,
      known_rules: input.rules.slice(0, 20).map((rule) => ({
        statement: rule.statement,
        severity: rule.severity,
        matcher: rule.matcher,
      })),
      open_issues: open,
    }

    const schema = ReviewResult
    const sys = [
      "You are Aegis, a senior engineering supervisor.",
      "Review worker-agent behavior and identify direction errors, invariant violations, and hallucination risk.",
      "Only return findings when intervention is necessary.",
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
      return {
        findings: value.findings.map((item) =>
          Finding.parse({
            ...item,
            source: "supervisor",
          }),
        ),
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
    return {
      findings: value.findings.map((item) =>
        Finding.parse({
          ...item,
          source: "supervisor",
        }),
      ),
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
      `Aegis supervisor detected an issue (${input.finding.severity.toUpperCase()}, L${input.level}).`,
      `Issue: ${input.finding.statement}`,
      `Required correction: ${input.finding.instruction}`,
      "Apply the correction now before continuing with new changes.",
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

  async function applyFinding(input: { sessionID: string; observation: Observation; finding: Finding }) {
    const cfg = await Config.get()
    const escalation = cfg.aegis?.escalation
    const warningAfter = escalation?.warning_after ?? 2
    const criticalAfter = escalation?.critical_after ?? 4

    const s = sessionSupervisor(input.sessionID)
    const prev = s.issues[input.finding.fingerprint]
    const count = (prev?.count ?? 0) + 1
    const level = count >= criticalAfter ? 3 : count >= warningAfter ? 2 : 1
    const now = Date.now()

    s.issues[input.finding.fingerprint] = {
      count,
      level,
      severity: input.finding.severity,
      statement: input.finding.statement,
      time: now,
      open: true,
    }

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

    const cooldown = s.injected[input.finding.fingerprint]
    if (cooldown && cooldown > now - 10_000) return

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
  }

  async function processObservation(input: { sessionID: string; observation: Observation }) {
    const obs = input.observation
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

    const rules = await activeRules()
    const deterministic = deterministicFindings(obs, rules)
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

    if (top) {
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
      await applyFinding({
        sessionID: input.sessionID,
        observation: obs,
        finding: top,
      })
    }

    await recordEvent({
      sessionID: input.sessionID,
      messageID: obs.messageID,
      partID: obs.partID,
      ruleID: top?.rule_id,
      type: "check_completed",
      payload: {
        kind: obs.kind,
        intervene: !!top,
        findings: merged.length,
        model: review.model,
      },
    })

    const s = sessionSupervisor(input.sessionID)
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
    const sessions = Database.use((db) =>
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
    const ids = sessions.map((item) => item.id)
    const sessionRows = ids.length
      ? Database.use((db) =>
          db
            .select()
            .from(AegisSessionTable)
            .where(inArray(AegisSessionTable.session_id, ids))
            .all(),
        )
      : []
    const bySession = new Map(sessionRows.map((item) => [item.session_id, normalizeState(item.state, item.session_id, totals)]))
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
      },
      sessions: summaries,
      interventions: interventions.map(toEvent).toReversed(),
    }
  }

  export async function workspaceEvents(input: z.input<typeof WorkspaceEventsInput>): Promise<WorkspaceEvents> {
    await ensureBootstrapped()
    const value = WorkspaceEventsInput.parse(input)
    const sessions = Database.use((db) =>
      db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.project_id, Instance.project.id))
        .all(),
    )
    const ids = sessions.map((item) => item.id)
    if (!ids.length) return { items: [], next_cursor: undefined }

    const rows = Database.use((db) =>
      db
        .select()
        .from(AegisEventTable)
        .where(
          and(
            inArray(AegisEventTable.session_id, ids),
            value.cursor ? lt(AegisEventTable.time_created, value.cursor) : undefined,
          ),
        )
        .orderBy(desc(AegisEventTable.time_created))
        .limit(value.limit + 1)
        .all(),
    )
    const more = rows.length > value.limit
    const slice = more ? rows.slice(0, value.limit) : rows
    return {
      items: slice.map(toEvent).toReversed(),
      next_cursor: more ? slice.at(-1)?.time_created : undefined,
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

  export const feedback = async (input: z.input<typeof FeedbackInput>) => {
    const value = FeedbackInput.parse(input)
    const eventRow = Database.use((db) => db.select().from(AegisEventTable).where(eq(AegisEventTable.id, value.eventID)).get())
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

    const rule = eventRow.rule_id
      ? Database.use((db) => db.select().from(AegisRuleTable).where(eq(AegisRuleTable.id, eventRow.rule_id!)).get())
      : undefined

    if (rule && rule.kind !== "explicit") {
      const next = Math.max(0, Math.min(100, rule.confidence + (value.helpful ? 5 : -10)))
      Database.use((db) =>
        db
          .update(AegisRuleTable)
          .set({ confidence: next })
          .where(eq(AegisRuleTable.id, rule.id))
          .run(),
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
      ruleID: eventRow.rule_id ?? undefined,
      type: "feedback",
      payload: {
        helpful: value.helpful,
        note: value.note,
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

    const items = memoryText(value.role, value.text)
    for (const statement of items) {
      const scope = memoryScope(statement)
      const rule = await createRule({
        scope,
        projectID: scope === "project" ? Instance.project.id : undefined,
        kind: value.role === "user" ? "explicit" : "runtime",
        statement,
        matcher: {},
        severity: value.role === "user" ? "high" : "medium",
        confidence: value.role === "user" ? 1 : 0.7,
        source: {
          type: "memory",
          value: value.role,
        },
      })
      const seen = Database.use((db) =>
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
      if (!seen) {
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
