import { Spinner } from "@tui/component/spinner"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { Locale } from "@/util/locale"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"

const PANELS = [
  { id: "overview", title: "Overview" },
  { id: "rules", title: "Rules" },
  { id: "interventions", title: "Interventions" },
  { id: "sessions", title: "Sessions" },
] as const

type Panel = (typeof PANELS)[number]["id"]
type Item = Record<string, unknown>

function text(input: unknown) {
  if (typeof input === "string") return input
  return undefined
}

function num(input: unknown) {
  if (typeof input === "number") return input
  return 0
}

function sev(payload: Item) {
  const value = payload.severity
  if (value === "low" || value === "medium" || value === "high") return value
  return "medium"
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
  return sev(event.payload) === "high"
}

export function Aegis() {
  const route = useRouteData("aegis")
  const { navigate } = useRoute()
  const sdk = useSDK()
  const { theme } = useTheme()

  const [panel, setPanel] = createSignal<Panel>(route.focus?.panel ?? "overview")
  const [ruleID, setRuleID] = createSignal(route.focus?.ruleID)
  const [eventID, setEventID] = createSignal(route.focus?.eventID)
  const [sessionID, setSessionID] = createSignal(route.focus?.sessionID)
  const [mode, setMode] = createSignal<"signal" | "all">("signal")

  const [workspace, workspaceOps] = createResource(async () => {
    const result = await sdk.client.session.aegisWorkspace({})
    return result.data
  })

  const [feed, feedOps] = createResource(async () => {
    const result = await sdk.client.session.aegisWorkspaceEvents({ limit: 100 })
    return result.data
  })

  const sync = () => {
    workspaceOps.refetch()
    feedOps.refetch()
  }

  onMount(() => {
    const timer = setInterval(sync, 3000)
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

  const interventions = createMemo(() => (workspace()?.interventions ?? []).toReversed())
  const sessions = createMemo(() => workspace()?.sessions ?? [])
  const events = createMemo(() => (feed()?.items ?? []).toReversed())
  const overview = createMemo(() => {
    if (mode() === "all") return events()
    return events().filter(risk)
  })

  createEffect(() => {
    if (panel() === "overview") {
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

  const selectedEvent = createMemo(() => {
    if (panel() === "overview") return overview().find((item) => item.id === eventID()) ?? overview()[0]
    if (panel() === "interventions") return interventions().find((item) => item.id === eventID()) ?? interventions()[0]
    return undefined
  })

  const selectedSession = createMemo(() => {
    if (panel() !== "sessions") return undefined
    return sessions().find((item) => item.session_id === sessionID()) ?? sessions()[0]
  })

  const stats = createMemo(() => ({
    checks: sessions().reduce((sum, item) => sum + item.checks, 0),
    unresolved: sessions().reduce((sum, item) => sum + item.unresolved, 0),
    interventions: sessions().reduce((sum, item) => sum + item.interventions, 0),
    queue: sessions().reduce((sum, item) => sum + item.queue, 0),
  }))

  const loading = createMemo(() => workspace.loading || feed.loading)
  const loaded = createMemo(() => Boolean(workspace() && feed()))
  const empty = createMemo(() => loaded() && sessions().length === 0 && rules().length === 0 && events().length === 0)

  const meta = createMemo(() => ({
    overview: {
      title: "Overview",
      count: `${overview().length}/${events().length} shown`,
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

  const sevColor = (value: "low" | "medium" | "high") => {
    if (value === "high") return theme.error
    if (value === "low") return theme.success
    return theme.warning
  }

  return (
    <box width="100%" height="100%" flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
      <Show
        when={loaded()}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
            <Spinner />
            <text fg={theme.textMuted}>{loading() ? "Loading Aegis workspace..." : "Unable to load Aegis workspace."}</text>
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
            <box width={24} border={["right"]} borderColor={theme.border} paddingRight={1} flexDirection="column">
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

            <box flexGrow={3} border={["right"]} borderColor={theme.border} paddingLeft={1} paddingRight={1} flexDirection="column">
              <box flexShrink={0} paddingBottom={1} justifyContent="space-between">
                <text fg={theme.text}>
                  <b>{meta()[panel()].title}</b>
                </text>
                <text fg={theme.textMuted}>{meta()[panel()].count}</text>
              </box>

              <scrollbox flexGrow={1} paddingRight={1}>
                <Show when={panel() === "overview"}>
                  <box flexShrink={0} flexDirection="row" gap={1} paddingBottom={1}>
                    <Filter label="Signal" active={mode() === "signal"} onClick={() => setMode("signal")} />
                    <Filter label="All" active={mode() === "all"} onClick={() => setMode("all")} />
                  </box>
                  <Show when={overview().length > 0} fallback={<text fg={theme.textMuted}>No events in this feed.</text>}>
                    <For each={overview().slice(0, 40)}>
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
                            <text fg={sevColor(sev(item.payload as Item))}>{label(item.type)}</text>
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

                <Show when={panel() === "rules"}>
                  <Show when={rules().length > 0} fallback={<text fg={theme.textMuted}>No rules yet.</text>}>
                    <For each={rules()}>
                      {(item) => (
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
                          <text fg={sevColor(item.severity)}>
                            {item.severity.toUpperCase()} {item.kind}
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>
                </Show>

                <Show when={panel() === "interventions"}>
                  <Show when={interventions().length > 0} fallback={<text fg={theme.textMuted}>No interventions yet.</text>}>
                    <For each={interventions()}>
                      {(item) => {
                        const payload = item.payload as Item
                        const level = sev(payload)
                        return (
                          <box
                            paddingLeft={1}
                            paddingRight={1}
                            paddingTop={1}
                            paddingBottom={1}
                            backgroundColor={eventID() === item.id ? theme.backgroundElement : theme.backgroundPanel}
                            onMouseUp={() => setEventID(item.id)}
                          >
                            <text fg={sevColor(level)} wrapMode="word">
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
                  <Show when={sessions().length > 0} fallback={<text fg={theme.textMuted}>No sessions tracked yet.</text>}>
                    <For each={sessions()}>
                      {(item) => (
                        <box
                          paddingLeft={1}
                          paddingRight={1}
                          paddingTop={1}
                          paddingBottom={1}
                          backgroundColor={sessionID() === item.session_id ? theme.backgroundElement : theme.backgroundPanel}
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
                  <b>Details</b>
                </text>
              </box>

              <scrollbox flexGrow={1} paddingRight={1}>
                <Show when={panel() === "overview" && selectedEvent()}>
                  {(item) => {
                    const payload = item().payload as Item
                    const level = sev(payload)
                    return (
                      <box gap={1}>
                        <KV label="Rules" value={`${workspace()?.rules.active ?? 0}/${workspace()?.rules.total ?? 0}`} tone="muted" />
                        <KV label="Sessions" value={`${sessions().length}`} tone="muted" />
                        <KV label="Checks" value={`${stats().checks}`} tone="muted" />
                        <KV label="Unresolved" value={`${stats().unresolved}`} tone={stats().unresolved > 0 ? "warning" : "success"} />
                        <KV label="Interventions" value={`${stats().interventions}`} tone={stats().interventions > 0 ? "warning" : "muted"} />
                        <KV label="Queue" value={`${stats().queue}`} tone={stats().queue > 0 ? "warning" : "muted"} />
                        <text fg={theme.border}> </text>
                        <KV label="Event ID" value={item().id} />
                        <KV label="Type" value={label(item().type)} />
                        <KV label="Session" value={item().session_id} />
                        <KV label="When" value={Locale.time(item().time.created)} />
                        <KV label="Severity" value={level.toUpperCase()} tone={level === "high" ? "error" : level === "low" ? "success" : "warning"} />
                        <text fg={theme.text} wrapMode="word">
                          {clip(summary(item()), 360)}
                        </text>
                        <Show when={action(item())}>
                          {(value) => (
                            <text fg={theme.warning} wrapMode="word">
                              Action {clip(value(), 320)}
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

                <Show when={panel() === "rules" && selectedRule()}>
                  {(item) => (
                    <box gap={1}>
                      <KV label="ID" value={item().id} />
                      <KV label="Scope" value={item().scope} />
                      <KV label="Kind" value={item().kind} />
                      <KV
                        label="Severity"
                        value={item().severity.toUpperCase()}
                        tone={item().severity === "high" ? "error" : item().severity === "low" ? "success" : "warning"}
                      />
                      <KV label="Active" value={item().active ? "yes" : "no"} />
                      <KV label="Confidence" value={`${item().confidence}`} />
                      <KV label="Source" value={`${item().source?.type ?? "unknown"} ${item().source?.value ?? ""}`} tone="muted" />
                      <text fg={theme.text} wrapMode="word">
                        {item().statement}
                      </text>
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
                    </box>
                  )}
                </Show>

                <Show when={panel() === "interventions" && selectedEvent()}>
                  {(item) => {
                    const payload = item().payload as Item
                    const level = sev(payload)
                    return (
                      <box gap={1}>
                        <KV label="ID" value={item().id} />
                        <KV label="Type" value={label(item().type)} />
                        <KV label="Session" value={item().session_id} />
                        <KV label="When" value={Locale.time(item().time.created)} />
                        <KV label="Severity" value={level.toUpperCase()} tone={level === "high" ? "error" : level === "low" ? "success" : "warning"} />
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
                      <KV label="Unresolved" value={`${item().unresolved}`} tone={item().unresolved > 0 ? "warning" : "success"} />
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

function KV(props: {
  label: string
  value: string
  tone?: "text" | "muted" | "warning" | "success" | "error"
}) {
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

function Filter(props: {
  label: string
  active: boolean
  onClick: () => void
}) {
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
