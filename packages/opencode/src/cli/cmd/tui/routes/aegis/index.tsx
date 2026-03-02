import { Spinner } from "@tui/component/spinner"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogModel } from "@tui/component/dialog-model"
import { Locale } from "@/util/locale"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"

const PANELS = [
  { id: "overview", title: "Overview" },
  { id: "rules", title: "Rules" },
  { id: "interventions", title: "Interventions" },
  { id: "sessions", title: "Sessions" },
] as const

const PRESETS = [
  { id: "none", label: "All" },
  { id: "active_fire", label: "Active fire" },
  { id: "new_regressions", label: "New regressions" },
  { id: "noisy_rules", label: "Noisy rules" },
  { id: "supervisor_struggling", label: "Supervisor is struggling" },
] as const

const THREAD_STATUS = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "watching", label: "Watching" },
  { id: "resolved", label: "Resolved" },
  { id: "noisy", label: "Noisy" },
] as const

type Panel = (typeof PANELS)[number]["id"]
type Item = Record<string, unknown>

type ThreadView = "threads" | "events"

function text(input: unknown) {
  if (typeof input === "string") return input
  return undefined
}

function bool(input: unknown) {
  if (typeof input === "boolean") return input
  return undefined
}

function sev(input: unknown) {
  if (input === "low" || input === "medium" || input === "high") return input
  return undefined
}

function summary(event: { type: string; payload: Item }) {
  return text(event.payload.statement) ?? text(event.payload.reason) ?? text(event.payload.issue) ?? event.type
}

function action(event: { payload: Item }) {
  return text(event.payload.instruction) ?? text(event.payload.action)
}

function short(id: string) {
  return id.slice(0, 8)
}

function clip(input: string, size: number) {
  if (input.length <= size) return input
  return `${input.slice(0, Math.max(0, size - 1))}…`
}

function label(input: string) {
  return input.replaceAll("_", " ")
}

function risk(event: { type: string; payload: Item }) {
  if (event.type === "violation" || event.type === "escalation" || event.type === "intervention_injected") return true
  const level = sev(event.payload.severity)
  return level === "high"
}

function parse(input: string) {
  try {
    const value = JSON.parse(input)
    if (value && typeof value === "object") return value as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

function matcher(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  const item = input as Record<string, unknown>
  const tool = text(item.tool)
  const pattern = text(item.pattern)
  const notPattern = text(item.not_pattern)
  return {
    tool,
    pattern,
    not_pattern: notPattern,
  }
}

function tone(value: "low" | "medium" | "high") {
  if (value === "high") return "error" as const
  if (value === "low") return "success" as const
  return "warning" as const
}

export function Aegis() {
  const route = useRouteData("aegis")
  const { navigate } = useRoute()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()

  const [panel, setPanel] = createSignal<Panel>(route.focus?.panel ?? "overview")
  const [ruleID, setRuleID] = createSignal(route.focus?.ruleID)
  const [eventID, setEventID] = createSignal(route.focus?.eventID)
  const [sessionID, setSessionID] = createSignal(route.focus?.sessionID)
  const [threadID, setThreadID] = createSignal<string>()
  const [mode, setMode] = createSignal<"signal" | "all">("signal")
  const [view, setView] = createSignal<ThreadView>("threads")
  const [preset, setPreset] = createSignal<(typeof PRESETS)[number]["id"]>("none")
  const [status, setStatus] = createSignal<(typeof THREAD_STATUS)[number]["id"]>("all")
  const [live, setLive] = createSignal(true)
  const [updated, setUpdated] = createSignal(Date.now())

  const [workspace, workspaceOps] = createResource(async () => {
    const result = await sdk.client.session.aegisWorkspace({})
    return result.data
  })

  const [feed, feedOps] = createResource(async () => {
    const result = await sdk.client.session.aegisWorkspaceEvents({ limit: 100 })
    return result.data
  })

  const [threads, threadsOps] = createResource(
    () => ({
      preset: preset(),
      status: status(),
    }),
    async (input) => {
      const result = await sdk.client.session.aegisWorkspaceThreads({
        limit: 200,
        preset: input.preset === "none" ? undefined : input.preset,
        status: input.status === "all" ? undefined : input.status,
      })
      return result.data
    },
  )

  const pull = () => {
    workspaceOps.refetch()
    feedOps.refetch()
    threadsOps.refetch()
    setUpdated(Date.now())
  }

  createEffect(() => {
    if (!live()) return
    const timer = setInterval(() => pull(), 3000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    if (!route.focus) return
    if (route.focus.panel) setPanel(route.focus.panel)
    if (route.focus.ruleID) setRuleID(route.focus.ruleID)
    if (route.focus.eventID) setEventID(route.focus.eventID)
    if (route.focus.sessionID) setSessionID(route.focus.sessionID)
  })

  const rules = createMemo(() => {
    if (!workspace()) return []
    return [...workspace()!.rules.project, ...workspace()!.rules.global]
  })

  const feedback = createMemo(() => workspace()?.rules.feedback_7d ?? {})
  const interventions = createMemo(() => (workspace()?.interventions ?? []).toReversed())
  const sessions = createMemo(() => workspace()?.sessions ?? [])
  const events = createMemo(() => (feed()?.items ?? []).toReversed())
  const threadItems = createMemo(() => threads()?.items ?? [])
  const overview = createMemo(() => {
    if (mode() === "all") return events()
    return events().filter(risk)
  })

  createEffect(() => {
    if (panel() === "overview" && view() === "threads") {
      if (!threadItems()[0]) return
      if (!threadItems().some((item) => item.key === threadID())) setThreadID(threadItems()[0]!.key)
    }
    if (panel() === "overview" && view() === "events") {
      if (!overview()[0]) return
      if (!overview().some((item) => item.id === eventID())) setEventID(overview()[0]!.id)
    }
    if (panel() === "rules" && !ruleID() && rules()[0]) setRuleID(rules()[0]!.id)
    if (panel() === "interventions" && !eventID() && interventions()[0]) setEventID(interventions()[0]!.id)
    if (panel() === "sessions" && !sessionID() && sessions()[0]) setSessionID(sessions()[0]!.session_id)
  })

  const selectedRule = createMemo(() => {
    if (panel() !== "rules") return undefined
    return rules().find((item) => item.id === ruleID()) ?? rules()[0]
  })

  const selectedThread = createMemo(() => {
    if (panel() !== "overview" || view() !== "threads") return undefined
    return threadItems().find((item) => item.key === threadID()) ?? threadItems()[0]
  })

  const selectedEvent = createMemo(() => {
    if (panel() === "overview" && view() === "events")
      return overview().find((item) => item.id === eventID()) ?? overview()[0]
    if (panel() === "interventions") return interventions().find((item) => item.id === eventID()) ?? interventions()[0]
    return undefined
  })

  const selectedSession = createMemo(() => {
    if (panel() !== "sessions") return undefined
    return sessions().find((item) => item.session_id === sessionID()) ?? sessions()[0]
  })

  const fromEvent = createMemo(() => {
    const item = selectedEvent()
    if (!item) return undefined
    const payload = item.payload as Item
    const fingerprint = text(payload.fingerprint)
    if (!fingerprint) return undefined
    return threadItems().find((thread) => thread.session_id === item.session_id && thread.fingerprint === fingerprint)
  })

  const focusThread = createMemo(() => selectedThread() ?? fromEvent())

  const stats = createMemo(() => ({
    checks: sessions().reduce((sum, item) => sum + item.checks, 0),
    unresolved: sessions().reduce((sum, item) => sum + item.unresolved, 0),
    interventions: sessions().reduce((sum, item) => sum + item.interventions, 0),
    queue: sessions().reduce((sum, item) => sum + item.queue, 0),
  }))

  const loading = createMemo(() => workspace.loading || feed.loading || threads.loading)
  const loaded = createMemo(() => Boolean(workspace() && feed() && threads()))
  const empty = createMemo(
    () =>
      loaded() &&
      sessions().length === 0 &&
      rules().length === 0 &&
      events().length === 0 &&
      threadItems().length === 0,
  )

  const meta = createMemo(() => ({
    overview: {
      title: "Overview",
      count:
        view() === "threads" ? `${threadItems().length} threads` : `${overview().length}/${events().length} events`,
    },
    rules: {
      title: "Rules",
      count: `${workspace()?.rules.active ?? 0}/${workspace()?.rules.total ?? 0} active`,
    },
    interventions: {
      title: "Interventions",
      count: `${interventions().length} recorded`,
    },
    sessions: {
      title: "Sessions",
      count: `${sessions().length} tracked`,
    },
  }))

  const now = createMemo(() => threads()?.now)
  const supervisor = createMemo(() => workspace()?.supervisor)
  const supervisorCurrent = createMemo(() => {
    const item = supervisor()
    if (!item?.provider || !item.model) return undefined
    return {
      providerID: item.provider,
      modelID: item.model,
    }
  })
  const supervisorLabel = createMemo(() => {
    const item = supervisor()
    if (!item?.provider || !item.model) return "default"
    return `${item.provider}/${item.model}`
  })

  const activeSession = createMemo(
    () =>
      focusThread()?.session_id ??
      selectedEvent()?.session_id ??
      selectedSession()?.session_id ??
      sessions()[0]?.session_id,
  )

  const run = async (fn: () => Promise<unknown>, fail: string) => {
    return fn().catch(() => DialogAlert.show(dialog, "Aegis", fail))
  }

  const setSupervisorModel = () => {
    dialog.replace(() => (
      <DialogModel
        title="Set Aegis supervisor model (global)"
        current={supervisorCurrent()}
        onSelect={async (value) => {
          const result = await sdk.client.global.config
            .update({
              config: {
                aegis: {
                  provider: value.providerID,
                  model: value.modelID,
                },
              },
            })
            .catch(() => undefined)
          if (!result) {
            await DialogAlert.show(dialog, "Aegis", "Unable to update global Aegis supervisor model")
            return
          }
          dialog.clear()
          pull()
        }}
      />
    ))
  }

  const markFeedback = async (helpful: boolean) => {
    const thread = focusThread()
    const event = selectedEvent()
    const session = thread?.session_id ?? event?.session_id
    const eventID = thread?.event_id ?? event?.id
    if (!session || !eventID) return
    const payload = (event?.payload ?? {}) as Item
    await run(
      () =>
        sdk.client.session.aegisFeedback({
          sessionID: session,
          eventID,
          helpful,
          fingerprint: thread?.fingerprint ?? text(payload.fingerprint),
          rule_id: thread?.rule_id ?? event?.rule_id,
        }),
      "Unable to submit feedback",
    )
    pull()
  }

  const editRule = async () => {
    const item = selectedRule()
    const session = activeSession()
    if (!item || !session) return

    const draft = JSON.stringify(
      {
        statement: item.statement,
        matcher: item.matcher,
        severity: item.severity,
        active: item.active,
      },
      null,
      2,
    )
    const raw = await DialogPrompt.show(dialog, "Edit rule JSON", {
      value: draft,
      placeholder: '{"statement":"...","matcher":{"pattern":"..."}}',
    })
    if (!raw) return
    const parsed = parse(raw)
    if (!parsed) {
      await DialogAlert.show(dialog, "Invalid JSON", "Could not parse the JSON payload")
      return
    }

    const next = {
      statement: text(parsed.statement) ?? item.statement,
      matcher: matcher(parsed.matcher) ?? item.matcher,
      severity: sev(parsed.severity) ?? item.severity,
      active: bool(parsed.active) ?? item.active,
    }

    const dry = await sdk.client.session.aegisRuleDryRun({
      sessionID: session,
      ruleID: item.id,
      matcher: next.matcher,
      window_ms: 24 * 60 * 60 * 1000,
      limit_examples: 3,
    })
    const preview = dry.data
    const examples = (preview?.examples ?? []).map(
      (example) => `- ${example.type} ${short(example.session_id)} ${example.summary}`,
    )
    const ok = await DialogConfirm.show(
      dialog,
      "Dry-run preview",
      [`Would have matched ${preview?.matched ?? 0} events in last 24h.`, ...examples].join("\n"),
    )
    if (!ok) return

    let confirmGlobal = false
    if (item.scope === "global") {
      confirmGlobal = await DialogConfirm.show(
        dialog,
        "Global rule edit",
        "This rule affects all projects. Confirm update?",
      )
      if (!confirmGlobal) return
    }

    await run(
      () =>
        sdk.client.session.aegisRuleUpdate({
          sessionID: session,
          ruleID: item.id,
          statement: next.statement,
          matcher: next.matcher,
          severity: next.severity,
          active: next.active,
          confirm_global: item.scope === "global" ? confirmGlobal : undefined,
        }),
      "Unable to update rule",
    )
    pull()
  }

  const deleteRule = async () => {
    const item = selectedRule()
    const session = activeSession()
    if (!item || !session) return

    const message =
      item.scope === "global"
        ? "This will deactivate a global rule and affects all projects. Continue?"
        : "This will deactivate the selected project rule. Continue?"
    const ok = await DialogConfirm.show(dialog, "Delete rule", message)
    if (!ok) return

    await run(
      () =>
        sdk.client.session.aegisRuleDelete({
          sessionID: session,
          ruleID: item.id,
          confirm_global: item.scope === "global" ? true : undefined,
        }),
      "Unable to delete rule",
    )
    pull()
  }

  const newRule = async () => {
    const session = activeSession()
    if (!session) return

    const statement = await DialogPrompt.show(dialog, "Rule statement", {
      placeholder: "Prefer existing project patterns over introducing new frameworks",
    })
    if (!statement) return
    const pattern = await DialogPrompt.show(dialog, "Matcher pattern", {
      placeholder: "tailwindcss|new framework",
    })
    if (!pattern) return
    const scopeValue = await DialogPrompt.show(dialog, "Scope", {
      value: "project",
      placeholder: "project or global",
    })
    const scope = scopeValue?.trim().toLowerCase() === "global" ? "global" : "project"
    const severityValue = await DialogPrompt.show(dialog, "Severity", {
      value: "high",
      placeholder: "low, medium, or high",
    })
    const severity = sev(severityValue?.trim().toLowerCase()) ?? "high"
    const dry = await sdk.client.session.aegisOverrideDryRun({
      sessionID: session,
      matcher: {
        pattern,
      },
      window_ms: 24 * 60 * 60 * 1000,
      limit_examples: 3,
    })
    const preview = dry.data
    const examples = (preview?.examples ?? []).map(
      (example) => `- ${example.type} ${short(example.session_id)} ${example.summary}`,
    )
    const ok = await DialogConfirm.show(
      dialog,
      "Dry-run preview",
      [`Would have matched ${preview?.matched ?? 0} events in last 24h.`, ...examples].join("\n"),
    )
    if (!ok) return

    if (scope === "global") {
      const confirm = await DialogConfirm.show(
        dialog,
        "Global rule create",
        "This rule affects all projects. Continue?",
      )
      if (!confirm) return
    }

    await run(
      () =>
        sdk.client.session.aegisOverride({
          sessionID: session,
          scope,
          statement,
          matcher: {
            pattern,
          },
          severity,
          active: true,
        }),
      "Unable to create rule",
    )
    pull()
  }

  const toggleRule = async () => {
    const item = selectedRule()
    const session = activeSession()
    if (!item || !session) return
    let confirmGlobal = false
    if (item.scope === "global") {
      confirmGlobal = await DialogConfirm.show(dialog, "Global rule toggle", "This affects all projects. Continue?")
      if (!confirmGlobal) return
    }
    await run(
      () =>
        sdk.client.session.aegisRuleUpdate({
          sessionID: session,
          ruleID: item.id,
          active: !item.active,
          confirm_global: item.scope === "global" ? confirmGlobal : undefined,
        }),
      "Unable to toggle rule",
    )
    pull()
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show
        when={loaded()}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
            <Spinner />
            <text fg={theme.textMuted}>
              {loading() ? "Loading Aegis workspace..." : "Unable to load Aegis workspace."}
            </text>
          </box>
        }
      >
        <Show
          when={!empty()}
          fallback={
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <text fg={theme.textMuted}>Aegis has not recorded events in this workspace yet.</text>
            </box>
          }
        >
          <box flexGrow={1} flexDirection="row" gap={1}>
            <box
              width={26}
              border={["right"]}
              borderColor={theme.border}
              paddingRight={1}
              flexDirection="column"
              gap={1}
            >
              <box
                paddingLeft={1}
                paddingRight={1}
                paddingTop={1}
                paddingBottom={1}
                backgroundColor={theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  <b>Now</b>
                </text>
                <KV
                  label="State"
                  value={label(now()?.state ?? "watching")}
                  tone={now()?.state === "intervening" ? "warning" : "muted"}
                />
                <KV label="Session" value={short(now()?.session_id ?? "none")} tone="muted" />
                <KV label="Agent" value={now()?.agent ?? "unknown"} tone="muted" />
                <KV label="Updated" value={Locale.time(updated())} tone="muted" />
              </box>

              <box
                paddingLeft={1}
                paddingRight={1}
                paddingTop={1}
                paddingBottom={1}
                backgroundColor={theme.backgroundPanel}
              >
                <KV
                  label="Unresolved"
                  value={`${stats().unresolved}`}
                  tone={stats().unresolved > 0 ? "warning" : "success"}
                />
                <KV label="Queue" value={`${stats().queue}`} tone={stats().queue > 0 ? "warning" : "muted"} />
                <KV label="Checks" value={`${stats().checks}`} tone="muted" />
                <KV
                  label="Interventions"
                  value={`${stats().interventions}`}
                  tone={stats().interventions > 0 ? "warning" : "muted"}
                />
                <KV
                  label="Supervisor"
                  value={supervisorLabel()}
                  tone={supervisor()?.configured ? "muted" : "warning"}
                />
                <KV label="Scope" value="global" tone="muted" />
                <box paddingTop={1}>
                  <Action label="Set model (global)" onClick={setSupervisorModel} />
                </box>
              </box>

              <For each={PANELS}>
                {(item) => (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    paddingTop={1}
                    paddingBottom={1}
                    onMouseUp={() => setPanel(item.id)}
                    backgroundColor={panel() === item.id ? theme.backgroundElement : theme.background}
                    flexDirection="column"
                  >
                    <text fg={panel() === item.id ? theme.text : theme.textMuted}>
                      {panel() === item.id ? "> " : "  "}
                      {item.title}
                    </text>
                    <text fg={theme.textMuted}>{meta()[item.id].count}</text>
                  </box>
                )}
              </For>
            </box>

            <box
              flexGrow={3}
              border={["right"]}
              borderColor={theme.border}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="column"
            >
              <box flexShrink={0} paddingBottom={1} justifyContent="space-between">
                <text fg={theme.text}>
                  <b>{meta()[panel()].title}</b>
                </text>
                <text fg={theme.textMuted}>{meta()[panel()].count}</text>
              </box>

              <scrollbox flexGrow={1} paddingRight={1}>
                <Show when={panel() === "overview"}>
                  <box flexShrink={0} flexDirection="row" gap={1} paddingBottom={1}>
                    <Filter label="Threads" active={view() === "threads"} onClick={() => setView("threads")} />
                    <Filter label="Events" active={view() === "events"} onClick={() => setView("events")} />
                    <Filter
                      label={live() ? "Live" : "Paused"}
                      active={live()}
                      onClick={() => setLive((prev) => !prev)}
                    />
                    <Filter label="Refresh" active={false} onClick={pull} />
                  </box>
                  <box flexShrink={0} flexDirection="row" gap={1} paddingBottom={1}>
                    <For each={PRESETS}>
                      {(item) => (
                        <Filter label={item.label} active={preset() === item.id} onClick={() => setPreset(item.id)} />
                      )}
                    </For>
                  </box>
                  <Show when={view() === "threads"}>
                    <box flexShrink={0} flexDirection="row" gap={1} paddingBottom={1}>
                      <For each={THREAD_STATUS}>
                        {(item) => (
                          <Filter label={item.label} active={status() === item.id} onClick={() => setStatus(item.id)} />
                        )}
                      </For>
                    </box>
                    <Show
                      when={threadItems().length > 0}
                      fallback={<text fg={theme.textMuted}>No thread matches this filter.</text>}
                    >
                      <For each={threadItems().slice(0, 80)}>
                        {(item) => (
                          <box
                            paddingLeft={1}
                            paddingRight={1}
                            paddingTop={1}
                            paddingBottom={1}
                            backgroundColor={threadID() === item.key ? theme.backgroundElement : theme.backgroundPanel}
                            onMouseUp={() => setThreadID(item.key)}
                            flexDirection="column"
                          >
                            <box justifyContent="space-between">
                              <text
                                fg={
                                  item.status === "resolved"
                                    ? theme.success
                                    : item.status === "noisy"
                                      ? theme.warning
                                      : tone(item.severity) === "error"
                                        ? theme.error
                                        : theme.text
                                }
                              >
                                {item.status.toUpperCase()} {item.type.replaceAll("_", " ")}
                              </text>
                              <text fg={theme.textMuted}>
                                {Locale.time(item.last_seen)} {short(item.session_id)}
                              </text>
                            </box>
                            <text fg={theme.text} wrapMode="none">
                              {clip(item.statement, 110)}
                            </text>
                            <text fg={theme.textMuted} wrapMode="none">
                              fp {clip(item.fingerprint, 30)} · count {item.count} · L{item.level} ·{" "}
                              {item.compliance.verdict}
                            </text>
                          </box>
                        )}
                      </For>
                    </Show>
                  </Show>

                  <Show when={view() === "events"}>
                    <box flexShrink={0} flexDirection="row" gap={1} paddingBottom={1}>
                      <Filter label="Signal" active={mode() === "signal"} onClick={() => setMode("signal")} />
                      <Filter label="All" active={mode() === "all"} onClick={() => setMode("all")} />
                    </box>
                    <Show
                      when={overview().length > 0}
                      fallback={<text fg={theme.textMuted}>No events in this feed.</text>}
                    >
                      <For each={overview().slice(0, 80)}>
                        {(item) => (
                          <box
                            paddingLeft={1}
                            paddingRight={1}
                            paddingTop={1}
                            paddingBottom={1}
                            backgroundColor={eventID() === item.id ? theme.backgroundElement : theme.backgroundPanel}
                            onMouseUp={() => setEventID(item.id)}
                            flexDirection="column"
                          >
                            <box justifyContent="space-between">
                              <text fg={tone(sev((item.payload as Item).severity) ?? "medium")}>
                                {label(item.type)}
                              </text>
                              <text fg={theme.textMuted}>
                                {Locale.time(item.time.created)} {short(item.session_id)}
                              </text>
                            </box>
                            <text fg={theme.text} wrapMode="none">
                              {clip(summary(item), 120)}
                            </text>
                          </box>
                        )}
                      </For>
                    </Show>
                  </Show>
                </Show>

                <Show when={panel() === "rules"}>
                  <box flexShrink={0} flexDirection="row" gap={1} paddingBottom={1}>
                    <Filter label="New rule" active={false} onClick={() => void newRule()} />
                  </box>
                  <Show when={rules().length > 0} fallback={<text fg={theme.textMuted}>No rules yet.</text>}>
                    <For each={rules()}>
                      {(item) => {
                        const row = feedback()[item.id]
                        return (
                          <box
                            paddingLeft={1}
                            paddingRight={1}
                            paddingTop={1}
                            paddingBottom={1}
                            backgroundColor={ruleID() === item.id ? theme.backgroundElement : theme.backgroundPanel}
                            onMouseUp={() => setRuleID(item.id)}
                          >
                            <text fg={item.active ? theme.text : theme.textMuted} wrapMode="word">
                              [{item.scope}] {item.statement}
                            </text>
                            <text fg={tone(item.severity)}>
                              {item.severity.toUpperCase()} {item.kind} · helpful {row?.score_7d ?? 0} /{" "}
                              {row?.count_7d ?? 0}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </Show>
                </Show>

                <Show when={panel() === "interventions"}>
                  <Show
                    when={interventions().length > 0}
                    fallback={<text fg={theme.textMuted}>No interventions yet.</text>}
                  >
                    <For each={interventions()}>
                      {(item) => {
                        const payload = item.payload as Item
                        const level = sev(payload.severity) ?? "medium"
                        return (
                          <box
                            paddingLeft={1}
                            paddingRight={1}
                            paddingTop={1}
                            paddingBottom={1}
                            backgroundColor={eventID() === item.id ? theme.backgroundElement : theme.backgroundPanel}
                            onMouseUp={() => setEventID(item.id)}
                          >
                            <text fg={tone(level)} wrapMode="word">
                              {level.toUpperCase()} {summary(item)}
                            </text>
                            <Show when={action(item)}>
                              {(value) => (
                                <text fg={theme.warning} wrapMode="word">
                                  action {value()}
                                </text>
                              )}
                            </Show>
                            <text fg={theme.textMuted}>
                              {Locale.time(item.time.created)} {item.type} session {short(item.session_id)}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </Show>
                </Show>

                <Show when={panel() === "sessions"}>
                  <Show
                    when={sessions().length > 0}
                    fallback={<text fg={theme.textMuted}>No sessions tracked yet.</text>}
                  >
                    <For each={sessions()}>
                      {(item) => (
                        <box
                          paddingLeft={1}
                          paddingRight={1}
                          paddingTop={1}
                          paddingBottom={1}
                          backgroundColor={
                            sessionID() === item.session_id ? theme.backgroundElement : theme.backgroundPanel
                          }
                          onMouseUp={() => setSessionID(item.session_id)}
                        >
                          <text fg={theme.text} wrapMode="word">
                            {item.title}
                          </text>
                          <text fg={theme.textMuted}>
                            {short(item.session_id)} {item.status} checks {item.checks} unresolved {item.unresolved}
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>
                </Show>
              </scrollbox>
            </box>

            <box flexGrow={2} paddingLeft={1} paddingRight={1} flexDirection="column">
              <box flexShrink={0} paddingBottom={1}>
                <text fg={theme.text}>
                  <b>Inspector</b>
                </text>
              </box>

              <scrollbox flexGrow={1} paddingRight={1}>
                <Show when={panel() === "overview" && view() === "threads" && selectedThread()}>
                  {(item) => (
                    <box gap={1}>
                      <KV label="Thread" value={item().key} tone="muted" />
                      <KV
                        label="Status"
                        value={item().status.toUpperCase()}
                        tone={item().status === "resolved" ? "success" : "warning"}
                      />
                      <KV label="Fingerprint" value={item().fingerprint} tone="muted" />
                      <KV label="Session" value={item().session_id} />
                      <KV label="Type" value={item().type} />
                      <KV label="Severity" value={item().severity.toUpperCase()} tone={tone(item().severity)} />
                      <KV label="Count" value={`${item().count}`} tone="muted" />
                      <KV label="Level" value={`${item().level}`} tone="muted" />
                      <KV label="Last seen" value={Locale.time(item().last_seen)} tone="muted" />
                      <text fg={theme.text} wrapMode="word">
                        {item().statement}
                      </text>

                      <text fg={theme.text}>
                        <b>Compliance loop</b>
                      </text>
                      <KV
                        label="Last instruction"
                        value={item().compliance.last_instruction ?? "unknown"}
                        tone="muted"
                      />
                      <KV
                        label="Observed response"
                        value={item().compliance.observed_response ?? "unknown"}
                        tone="muted"
                      />
                      <KV
                        label="Verdict"
                        value={item().compliance.verdict.toUpperCase()}
                        tone={item().compliance.verdict === "complied" ? "success" : "warning"}
                      />
                      <KV label="Auto-followups" value={`${item().compliance.followups}`} tone="muted" />

                      <box flexDirection="row" gap={1}>
                        <Action label="Helpful" onClick={() => void markFeedback(true)} />
                        <Action label="Not helpful" onClick={() => void markFeedback(false)} />
                      </box>

                      <text
                        fg={theme.primary}
                        onMouseUp={() =>
                          navigate({
                            type: "session",
                            sessionID: item().session_id,
                          })
                        }
                      >
                        Open session {short(item().session_id)}
                      </text>
                    </box>
                  )}
                </Show>

                <Show when={panel() === "overview" && view() === "events" && selectedEvent()}>
                  {(item) => {
                    const payload = item().payload as Item
                    const level = sev(payload.severity) ?? "medium"
                    return (
                      <box gap={1}>
                        <KV label="Event ID" value={item().id} />
                        <KV label="Type" value={label(item().type)} />
                        <KV label="Session" value={item().session_id} />
                        <KV label="When" value={Locale.time(item().time.created)} />
                        <KV label="Severity" value={level.toUpperCase()} tone={tone(level)} />
                        <text fg={theme.text} wrapMode="word">
                          {clip(summary(item()), 360)}
                        </text>

                        <text fg={theme.text}>
                          <b>Compliance loop</b>
                        </text>
                        <KV
                          label="Last instruction"
                          value={focusThread()?.compliance.last_instruction ?? "unknown"}
                          tone="muted"
                        />
                        <KV
                          label="Observed response"
                          value={focusThread()?.compliance.observed_response ?? "unknown"}
                          tone="muted"
                        />
                        <KV
                          label="Verdict"
                          value={(focusThread()?.compliance.verdict ?? "unknown").toUpperCase()}
                          tone="warning"
                        />
                        <KV label="Auto-followups" value={`${focusThread()?.compliance.followups ?? 0}`} tone="muted" />

                        <box flexDirection="row" gap={1}>
                          <Action label="Helpful" onClick={() => void markFeedback(true)} />
                          <Action label="Not helpful" onClick={() => void markFeedback(false)} />
                        </box>

                        <text
                          fg={theme.primary}
                          onMouseUp={() =>
                            navigate({
                              type: "session",
                              sessionID: item().session_id,
                            })
                          }
                        >
                          Open session {short(item().session_id)}
                        </text>
                      </box>
                    )
                  }}
                </Show>

                <Show when={panel() === "rules" && selectedRule()}>
                  {(item) => {
                    const row = feedback()[item().id]
                    return (
                      <box gap={1}>
                        <KV label="ID" value={item().id} />
                        <KV label="Scope" value={item().scope} />
                        <KV label="Kind" value={item().kind} />
                        <KV label="Severity" value={item().severity.toUpperCase()} tone={tone(item().severity)} />
                        <KV label="Active" value={item().active ? "yes" : "no"} />
                        <KV label="Confidence" value={`${item().confidence}`} />
                        <KV
                          label="Helpfulness"
                          value={`${row?.score_7d ?? 0} / ${row?.count_7d ?? 0} (7d)`}
                          tone="muted"
                        />
                        <KV
                          label="Source"
                          value={`${item().source?.type ?? "unknown"} ${item().source?.value ?? ""}`}
                          tone="muted"
                        />
                        <text fg={theme.text} wrapMode="word">
                          {item().statement}
                        </text>
                        <Show when={item().scope === "global"}>
                          <text fg={theme.warning} wrapMode="word">
                            Global rule: edits affect all projects.
                          </text>
                        </Show>
                        <Show when={item().matcher.tool || item().matcher.pattern || item().matcher.not_pattern}>
                          <box>
                            <Show when={item().matcher.tool}>
                              {(value) => <KV label="Tool" value={value()} tone="muted" />}
                            </Show>
                            <Show when={item().matcher.pattern}>
                              {(value) => <KV label="Pattern" value={value()} tone="muted" />}
                            </Show>
                            <Show when={item().matcher.not_pattern}>
                              {(value) => <KV label="Not Pattern" value={value()} tone="muted" />}
                            </Show>
                          </box>
                        </Show>
                        <box flexDirection="row" gap={1}>
                          <Action label="Edit + dry-run" onClick={() => void editRule()} />
                          <Action label={item().active ? "Deactivate" : "Activate"} onClick={() => void toggleRule()} />
                          <Action label="Delete" onClick={() => void deleteRule()} />
                        </box>
                      </box>
                    )
                  }}
                </Show>

                <Show when={panel() === "interventions" && selectedEvent()}>
                  {(item) => {
                    const payload = item().payload as Item
                    const level = sev(payload.severity) ?? "medium"
                    return (
                      <box gap={1}>
                        <KV label="ID" value={item().id} />
                        <KV label="Type" value={label(item().type)} />
                        <KV label="Session" value={item().session_id} />
                        <KV label="When" value={Locale.time(item().time.created)} />
                        <KV label="Severity" value={level.toUpperCase()} tone={tone(level)} />
                        <text fg={theme.text} wrapMode="word">
                          {summary(item())}
                        </text>
                        <Show when={action(item())}>
                          {(value) => (
                            <text fg={theme.warning} wrapMode="word">
                              Action {value()}
                            </text>
                          )}
                        </Show>
                        <Show when={text(payload.fingerprint)}>
                          {(value) => <KV label="Fingerprint" value={value()} tone="muted" />}
                        </Show>
                        <Show when={payload.level !== undefined}>
                          <KV label="Level" value={`${payload.level}`} tone="muted" />
                        </Show>
                        <text
                          fg={theme.primary}
                          onMouseUp={() =>
                            navigate({
                              type: "session",
                              sessionID: item().session_id,
                            })
                          }
                        >
                          Open session {short(item().session_id)}
                        </text>
                      </box>
                    )
                  }}
                </Show>

                <Show when={panel() === "sessions" && selectedSession()}>
                  {(item) => (
                    <box gap={1}>
                      <KV label="Title" value={item().title} />
                      <KV label="ID" value={item().session_id} />
                      <KV label="Status" value={item().status} />
                      <KV label="Mode" value={item().mode} />
                      <KV label="Model" value={item().model ?? "default"} />
                      <KV label="Checks" value={`${item().checks}`} />
                      <KV label="Queue" value={`${item().queue}`} tone={item().queue > 0 ? "warning" : "muted"} />
                      <KV
                        label="Unresolved"
                        value={`${item().unresolved}`}
                        tone={item().unresolved > 0 ? "warning" : "success"}
                      />
                      <KV
                        label="Interventions"
                        value={`${item().interventions}`}
                        tone={item().interventions > 0 ? "warning" : "muted"}
                      />
                      <KV label="Tokens" value={`${item().tokens.input}/${item().tokens.output}`} tone="muted" />
                      <Show when={item().last_violation}>
                        {(value) => (
                          <text fg={theme.warning} wrapMode="word">
                            Last violation {value().statement}
                          </text>
                        )}
                      </Show>
                      <Show when={item().last_intervention}>
                        {(value) => (
                          <text fg={theme.textMuted} wrapMode="word">
                            Last intervention level {value().level} fingerprint {value().fingerprint}
                          </text>
                        )}
                      </Show>
                      <text
                        fg={theme.primary}
                        onMouseUp={() =>
                          navigate({
                            type: "session",
                            sessionID: item().session_id,
                          })
                        }
                      >
                        Open session {short(item().session_id)}
                      </text>
                    </box>
                  )}
                </Show>
              </scrollbox>
            </box>
          </box>
        </Show>
      </Show>
    </box>
  )
}

function Action(props: { label: string; onClick: () => void }) {
  const { theme } = useTheme()
  return (
    <box backgroundColor={theme.backgroundElement} onMouseUp={props.onClick} paddingLeft={1} paddingRight={1}>
      <text fg={theme.text}>{props.label}</text>
    </box>
  )
}

function KV(props: { label: string; value: string; tone?: "text" | "muted" | "warning" | "success" | "error" }) {
  const { theme } = useTheme()
  const color = createMemo(() => {
    if (props.tone === "warning") return theme.warning
    if (props.tone === "success") return theme.success
    if (props.tone === "error") return theme.error
    if (props.tone === "muted") return theme.textMuted
    return theme.text
  })
  return (
    <text fg={color()} wrapMode="word">
      {props.label}: {props.value}
    </text>
  )
}

function Filter(props: { label: string; active: boolean; onClick: () => void }) {
  const { theme } = useTheme()
  return (
    <box
      backgroundColor={props.active ? theme.backgroundElement : theme.backgroundPanel}
      onMouseUp={props.onClick}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={props.active ? theme.text : theme.textMuted}>{props.label}</text>
    </box>
  )
}
