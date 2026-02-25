import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Aegis } from "../../src/aegis"
import { MessageV2 } from "../../src/session/message-v2"

describe("aegis", () => {
  async function waitFor(fn: () => Promise<boolean>, timeout = 3000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await fn()) return true
      await Bun.sleep(20)
    }
    return false
  }

  test("records violations and injects intervention prompts", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(
          path.join(cwd, "AGENTS.md"),
          ["Always use zod for validation", "Never use forbidden-lib in this repository"].join("\n"),
        )
        await Bun.write(
          path.join(cwd, "opencode.json"),
          JSON.stringify(
            {
              aegis: {
                review: {
                  tool_call: false,
                  tool_result: false,
                  assistant_text: false,
                  patch: false,
                },
              },
            },
            null,
            2,
          ),
        )
      },
    })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "start task",
            },
          ],
        })

        await Aegis.override({
          sessionID: session.id,
          scope: "project",
          statement: "Avoid forbidden-lib in this repository",
          matcher: {
            tool: "edit",
            pattern: "forbidden-lib",
          },
          severity: "high",
        })

        await Aegis.observeToolCall({
          sessionID: session.id,
          messageID: user.info.id,
          tool: "edit",
          input: {
            old: "const a = 1",
            new: "import { x } from 'forbidden-lib'",
          },
        })

        const done = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((item) => item.type === "intervention_injected")
        })
        expect(done).toBe(true)

        const snapshot = await Aegis.snapshot(session.id)
        expect(snapshot.state.checks).toBeGreaterThan(0)
        expect(snapshot.events.some((item) => item.type === "violation")).toBe(true)
        expect(snapshot.events.some((item) => item.type === "intervention_injected")).toBe(true)

        const messages = await Session.messages({
          sessionID: session.id,
        })
        const injected = messages.findLast((item) => {
          if (item.info.role !== "user") return false
          return item.parts.some(
            (part) => part.type === "text" && part.synthetic && part.text.includes("Aegis supervisor detected an issue"),
          )
        })
        expect(injected).toBeDefined()

        const loaded = await MessageV2.get({
          sessionID: session.id,
          messageID: injected!.info.id,
        })
        const visible = loaded.parts.find((item) => item.type === "text" && !item.synthetic)
        expect(visible).toBeUndefined()
      },
    })
  })

  test("remembers project details from chat text without injecting blanket reminders", async () => {
    await using dir = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "Remember that the accent theme is #258937 for this project.",
            },
          ],
        })

        const first = await Aegis.snapshot(session.id)
        expect(
          first.events.some((event) => {
            if (event.type !== "memory") return false
            const statement = event.payload.statement
            return typeof statement === "string" && statement.includes("#258937")
          }),
        ).toBe(true)

        const follow = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "Create the hero section.",
            },
          ],
        })

        expect(
          follow.parts.some((part) => {
            if (part.type !== "text") return false
            if (!part.synthetic) return false
            return part.text.includes("Aegis remembered these project details") && part.text.includes("#258937")
          }),
        ).toBe(false)
      },
    })
  })
})
