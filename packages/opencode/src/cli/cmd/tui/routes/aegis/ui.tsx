import { useTheme } from "@tui/context/theme"
import { createMemo, createSignal, type JSX } from "solid-js"

export type Tone = "text" | "muted" | "warning" | "success" | "error"

function toneColor(tone: Tone | undefined, theme: ReturnType<typeof useTheme>["theme"]) {
  if (tone === "warning") return theme.warning
  if (tone === "success") return theme.success
  if (tone === "error") return theme.error
  if (tone === "muted") return theme.textMuted
  return theme.text
}

export function Surface(props: { children: JSX.Element; tight?: boolean }) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="column"
      gap={props.tight ? 0 : 1}
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.borderSubtle}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      {props.children}
    </box>
  )
}

export function ListRow(props: { active: boolean; onClick: () => void; children: JSX.Element; tight?: boolean }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const background = createMemo(() => {
    if (props.active) return theme.backgroundElement
    if (hover()) return theme.backgroundElement
    return theme.backgroundPanel
  })
  return (
    <box
      flexDirection="column"
      gap={props.tight ? 0 : 1}
      backgroundColor={background()}
      border={["left"]}
      borderColor={props.active ? theme.primary : theme.borderSubtle}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onClick}
    >
      {props.children}
    </box>
  )
}

export function NavButton(props: {
  title: string
  count: string
  active: boolean
  onClick: () => void
  tight?: boolean
}) {
  const { theme } = useTheme()
  return (
    <ListRow active={props.active} onClick={props.onClick} tight={props.tight}>
      <text fg={props.active ? theme.text : theme.textMuted} wrapMode="none">
        {props.active ? "> " : "  "}
        {props.title}
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        {props.count}
      </text>
    </ListRow>
  )
}

export function Badge(props: { label: string; tone?: Tone }) {
  const { theme } = useTheme()
  const color = createMemo(() => toneColor(props.tone, theme))
  return (
    <text wrapMode="none">
      <span style={{ bg: theme.background, fg: color(), bold: true }}> {props.label} </span>
    </text>
  )
}

export function Action(props: {
  label: string
  onClick: () => void
  tone?: "default" | "primary" | "danger"
  tight?: boolean
}) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const color = createMemo(() => {
    if (props.tone === "danger") return theme.error
    if (props.tone === "primary") return theme.primary
    return theme.text
  })
  return (
    <box
      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      border={["left"]}
      borderColor={hover() ? color() : theme.borderSubtle}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onClick}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={props.tight ? 0 : undefined}
      paddingBottom={props.tight ? 0 : undefined}
    >
      <text fg={color()} wrapMode="none">
        {props.label}
      </text>
    </box>
  )
}

export function KV(props: { label: string; value: string; tone?: Tone }) {
  const { theme } = useTheme()
  const color = createMemo(() => toneColor(props.tone, theme))
  return (
    <text wrapMode="word">
      <span style={{ fg: theme.textMuted }}>{props.label}</span>
      <span style={{ fg: color() }}>{`: ${props.value}`}</span>
    </text>
  )
}

export function Filter(props: { label: string; active: boolean; onClick: () => void; tight?: boolean }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const active = createMemo(() => props.active || hover())
  return (
    <box
      backgroundColor={active() ? theme.backgroundElement : theme.backgroundPanel}
      border={["left"]}
      borderColor={props.active ? theme.primary : theme.borderSubtle}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onClick}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={props.tight ? 0 : undefined}
      paddingBottom={props.tight ? 0 : undefined}
    >
      <text fg={props.active ? theme.text : theme.textMuted} wrapMode="none">
        {props.label}
      </text>
    </box>
  )
}
