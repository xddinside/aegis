import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"
import type { Aegis } from "."

export const AegisRuleTable = sqliteTable(
  "aegis_rule",
  {
    id: text().primaryKey(),
    scope: text().notNull().$type<Aegis.RuleScope>(),
    project_id: text().references(() => ProjectTable.id, { onDelete: "cascade" }),
    kind: text().notNull().$type<Aegis.RuleKind>(),
    statement: text().notNull(),
    matcher: text({ mode: "json" }).notNull().$type<Aegis.Matcher>(),
    severity: text().notNull().$type<Aegis.RuleSeverity>(),
    confidence: integer().notNull(),
    source: text({ mode: "json" }).$type<Aegis.RuleSource>(),
    active: integer().notNull().default(1),
    ...Timestamps,
  },
  (table) => [index("aegis_rule_scope_idx").on(table.scope), index("aegis_rule_project_idx").on(table.project_id)],
)

export const AegisEventTable = sqliteTable(
  "aegis_event",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text(),
    part_id: text(),
    rule_id: text().references(() => AegisRuleTable.id, { onDelete: "set null" }),
    type: text().notNull().$type<Aegis.EventType>(),
    payload: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("aegis_event_session_idx").on(table.session_id),
    index("aegis_event_rule_idx").on(table.rule_id),
    index("aegis_event_type_idx").on(table.type),
  ],
)

export const AegisSessionTable = sqliteTable("aegis_session", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  state: text({ mode: "json" }).notNull().$type<Aegis.SessionState>(),
  ...Timestamps,
})
