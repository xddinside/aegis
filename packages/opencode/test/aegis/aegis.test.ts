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
          path.join(cwd, "aegis.json"),
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

        const rule = await Aegis.override({
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
            (part) => part.type === "text" && part.synthetic && part.text.includes("Aegis noticed a potential issue"),
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

  test("builds fingerprint threads and supports rule dry-run/update/delete with feedback stats", async () => {
    await using dir = await tmpdir({
      git: true,
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

        const rule = await Aegis.override({
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

        const ok = await waitFor(async () => {
          const data = await Aegis.workspaceThreads({})
          return data.items.length > 0
        })
        expect(ok).toBe(true)

        const threads = await Aegis.workspaceThreads({})
        const thread = threads.items.find((item) => item.session_id === session.id)
        expect(thread).toBeDefined()

        const dry = await Aegis.dryRunRule({
          sessionID: session.id,
          matcher: {
            pattern: "forbidden-lib",
            tool: "edit",
          },
          window_ms: 24 * 60 * 60 * 1000,
        })
        expect(dry.matched).toBeGreaterThan(0)

        const updated = await Aegis.updateRule({
          sessionID: session.id,
          ruleID: rule.id,
          severity: "low",
        })
        expect(updated.severity).toBe("low")

        const removed = await Aegis.deleteRule({
          sessionID: session.id,
          ruleID: rule.id,
        })
        expect(removed.active).toBe(false)

        await Aegis.feedback({
          sessionID: session.id,
          eventID: thread!.event_id,
          helpful: false,
          fingerprint: thread!.fingerprint,
          rule_id: thread!.rule_id,
        })

        const workspace = await Aegis.workspace()
        const score = workspace.rules.feedback_7d[rule.id]
        expect(score).toBeDefined()
        expect(score?.count_7d).toBeGreaterThan(0)
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

  test("captures shorthand remember statements as memory rules", async () => {
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
              text: "remember #258937 as the accent color",
            },
          ],
        })

        const done = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((event) => event.type === "memory")
        })
        expect(done).toBe(true)

        const workspace = await Aegis.workspace()
        expect(
          [...workspace.rules.project, ...workspace.rules.global].some((rule) => rule.statement.includes("#258937")),
        ).toBe(true)
      },
    })
  })

  test("does not store assistant acknowledgement promises as memory rules", async () => {
    await using dir = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "start task",
            },
          ],
        })

        await Aegis.observeText({
          sessionID: session.id,
          messageID: base.info.id,
          role: "assistant",
          text: "I'll convert this to a Next.js project as suggested.",
        })

        const workspace = await Aegis.workspace()
        expect(
          [...workspace.rules.project, ...workspace.rules.global].some((rule) =>
            rule.statement.toLowerCase().includes("i'll convert this to a next.js project as suggested"),
          ),
        ).toBe(false)
      },
    })
  })

  test("keeps durable assistant project constraints as memory rules", async () => {
    await using dir = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "start task",
            },
          ],
        })

        await Aegis.observeText({
          sessionID: session.id,
          messageID: base.info.id,
          role: "assistant",
          text: "For this project, always use Next.js as the default stack if none is specified.",
        })

        const done = await waitFor(async () => {
          const workspace = await Aegis.workspace()
          return [...workspace.rules.project, ...workspace.rules.global].some((rule) =>
            rule.statement.toLowerCase().includes("for this project, always use next.js"),
          )
        })
        expect(done).toBe(true)
      },
    })
  })

  test("captures multiline remember directives with skill-like values", async () => {
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
              text: "remember this:\\n/frontend-design",
            },
          ],
        })

        const done = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((event) => event.type === "memory")
        })
        expect(done).toBe(true)

        const workspace = await Aegis.workspace()
        expect(
          [...workspace.rules.project, ...workspace.rules.global].some((rule) =>
            rule.statement.includes("/frontend-design"),
          ),
        ).toBe(true)
      },
    })
  })

  test("enforces default-stack memory rules when assistant proposes plain html/css/js", async () => {
    await using dir = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "remember this: use nextjs always globally if no stack is specified",
            },
          ],
        })

        const memoryDone = await waitFor(async () => {
          const workspace = await Aegis.workspace()
          return [...workspace.rules.project, ...workspace.rules.global].some((rule) =>
            rule.statement.toLowerCase().includes("use nextjs always globally if no stack is specified"),
          )
        })
        expect(memoryDone).toBe(true)

        await Aegis.observeText({
          sessionID: session.id,
          messageID: base.info.id,
          role: "assistant",
          text: "I'll create this with plain HTML/CSS/JS and no framework.",
        })

        const intervention = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((event) => event.type === "intervention_injected")
        })
        expect(intervention).toBe(true)
      },
    })
  })

  test("enforces default-stack memory rules on root index.html patch writes", async () => {
    await using dir = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "remember this: use nextjs always globally if no stack is specified",
            },
          ],
        })

        const memoryDone = await waitFor(async () => {
          const workspace = await Aegis.workspace()
          return [...workspace.rules.project, ...workspace.rules.global].some((rule) =>
            rule.statement.toLowerCase().includes("use nextjs always globally if no stack is specified"),
          )
        })
        expect(memoryDone).toBe(true)

        await Aegis.observePatch({
          sessionID: session.id,
          messageID: base.info.id,
          files: ["index.html"],
        })

        const intervention = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((event) => event.type === "intervention_injected")
        })
        expect(intervention).toBe(true)
      },
    })
  })

  test("dry-run previews policy matches for default-stack rules", async () => {
    await using dir = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "start task",
            },
          ],
        })

        await Aegis.observePatch({
          sessionID: session.id,
          messageID: base.info.id,
          files: ["index.html"],
        })

        const dry = await Aegis.dryRunRule({
          sessionID: session.id,
          matcher: {
            policy: {
              intent: "default_stack",
              target: "nextjs",
              condition: "if_no_stack_specified",
            },
          },
          window_ms: 24 * 60 * 60 * 1000,
        })

        expect(dry.matched).toBeGreaterThan(0)
        expect(dry.examples.some((event) => event.type === "observe_patch")).toBe(true)
      },
    })
  })

  test("flags completion claim when requested paths have no evidence", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(
          path.join(cwd, "aegis.json"),
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
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Update docs/guide.md with setup instructions." }],
        })

        await Aegis.observeText({
          sessionID: session.id,
          messageID: base.info.id,
          role: "assistant",
          text: "Done. Completed all requested updates.",
        })

        const ok = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((item) => {
            if (item.type !== "violation") return false
            const fingerprint = item.payload.fingerprint
            return typeof fingerprint === "string" && fingerprint.startsWith("context:path:")
          })
        })
        expect(ok).toBe(true)
      },
    })
  })

  test("flags completion claim when tests were requested without evidence", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(
          path.join(cwd, "aegis.json"),
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
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Implement parser changes and add unit tests." }],
        })

        await Aegis.observeText({
          sessionID: session.id,
          messageID: base.info.id,
          role: "assistant",
          text: "Done. Implemented parser changes and verified everything.",
        })

        const ok = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((item) => {
            if (item.type !== "violation") return false
            const fingerprint = item.payload.fingerprint
            return typeof fingerprint === "string" && fingerprint.startsWith("context:test:")
          })
        })
        expect(ok).toBe(true)
      },
    })
  })

  test("does not flag completion claim when requested path and test evidence exists", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(
          path.join(cwd, "aegis.json"),
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
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Update src/parser.ts and add unit tests." }],
        })

        await Aegis.observePatch({
          sessionID: session.id,
          messageID: base.info.id,
          files: ["src/parser.ts", "src/parser.test.ts"],
        })

        await Aegis.observeText({
          sessionID: session.id,
          messageID: base.info.id,
          role: "assistant",
          text: "Done. Completed the parser update and tests.",
        })

        const settled = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.state.checks >= 2
        })
        expect(settled).toBe(true)

        const snapshot = await Aegis.snapshot(session.id)
        expect(
          snapshot.events.some((item) => {
            if (item.type !== "violation") return false
            const fingerprint = item.payload.fingerprint
            if (typeof fingerprint !== "string") return false
            return fingerprint.startsWith("context:path:") || fingerprint.startsWith("context:test:")
          }),
        ).toBe(false)
      },
    })
  })

  test("flags ecosystem mismatch when worker shifts away from repository conventions", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(path.join(cwd, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2))
        await Bun.write(
          path.join(cwd, "aegis.json"),
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
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Create a command helper." }],
        })

        await Aegis.observeText({
          sessionID: session.id,
          messageID: base.info.id,
          role: "assistant",
          text: "I will implement this in Python with a pyproject.toml and .py files.",
        })

        const ok = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((item) => {
            if (item.type !== "violation") return false
            const fingerprint = item.payload.fingerprint
            return typeof fingerprint === "string" && fingerprint.startsWith("context:ecosystem:")
          })
        })
        expect(ok).toBe(true)
      },
    })
  })

  test("does not flag ecosystem mismatch when user explicitly asks for that ecosystem", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(path.join(cwd, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2))
        await Bun.write(
          path.join(cwd, "aegis.json"),
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
        const base = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Create a small Python helper script for this task." }],
        })

        await Aegis.observeText({
          sessionID: session.id,
          messageID: base.info.id,
          role: "assistant",
          text: "I will implement this in Python with a pyproject.toml and .py files.",
        })

        const settled = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.state.checks >= 1
        })
        expect(settled).toBe(true)

        const snapshot = await Aegis.snapshot(session.id)
        expect(
          snapshot.events.some((item) => {
            if (item.type !== "violation") return false
            const fingerprint = item.payload.fingerprint
            return typeof fingerprint === "string" && fingerprint.startsWith("context:ecosystem:")
          }),
        ).toBe(false)
      },
    })
  })

  test("workspace reports configured supervisor model from aegis config", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(
          path.join(cwd, "aegis.json"),
          JSON.stringify(
            {
              aegis: {
                provider: "openai",
                model: "gpt-4o-mini",
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
        const workspace = await Aegis.workspace()
        expect(workspace.supervisor.configured).toBe(true)
        expect(workspace.supervisor.provider).toBe("openai")
        expect(workspace.supervisor.model).toBe("gpt-4o-mini")
      },
    })
  })

  test("suppresses repeated reinjection while holdoff is active", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(
          path.join(cwd, "aegis.json"),
          JSON.stringify(
            {
              aegis: {
                intervention: {
                  base_holdoff_ms: 200,
                  progress_extend_ms: 120,
                  max_holdoff_ms: 400,
                  stall_timeout_ms: 500,
                  contradiction_bypass: false,
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
          parts: [{ type: "text", text: "start task" }],
        })

        const rule = await Aegis.override({
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

        const first = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.filter((item) => item.type === "intervention_injected").length === 1
        })
        expect(first).toBe(true)

        await Aegis.observeToolCall({
          sessionID: session.id,
          messageID: user.info.id,
          tool: "edit",
          input: {
            old: "const b = 2",
            new: "import { y } from 'forbidden-lib'",
          },
        })

        const settled = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.state.checks >= 2
        })
        expect(settled).toBe(true)

        const snapshot = await Aegis.snapshot(session.id)
        expect(snapshot.events.filter((item) => item.type === "intervention_injected").length).toBe(1)
        expect(
          snapshot.events.some((item) => {
            if (item.type !== "check_completed") return false
            const reason = item.payload.suppressed_reason
            return reason === "holdoff_active" || reason === "recent_progress"
          }),
        ).toBe(true)
      },
    })
  })

  test("sends followup intervention after stall timeout", async () => {
    await using dir = await tmpdir({
      git: true,
      init: async (cwd) => {
        await Bun.write(
          path.join(cwd, "aegis.json"),
          JSON.stringify(
            {
              aegis: {
                intervention: {
                  base_holdoff_ms: 80,
                  progress_extend_ms: 40,
                  max_holdoff_ms: 200,
                  stall_timeout_ms: 80,
                  contradiction_bypass: false,
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
          parts: [{ type: "text", text: "start task" }],
        })

        const rule = await Aegis.override({
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

        const first = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.filter((item) => item.type === "intervention_injected").length === 1
        })
        expect(first).toBe(true)

        await Bun.sleep(220)

        await Aegis.observeToolCall({
          sessionID: session.id,
          messageID: user.info.id,
          tool: "edit",
          input: {
            old: "const c = 3",
            new: "import { z } from 'forbidden-lib'",
          },
        })

        const second = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.filter((item) => item.type === "intervention_injected").length >= 2
        })
        expect(second).toBe(true)
      },
    })
  })

  test("workspace threads collapse violation and intervention into one thread per fingerprint", async () => {
    await using dir = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "start task" }],
        })

        const rule = await Aegis.override({
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

        const ready = await waitFor(async () => {
          const snapshot = await Aegis.snapshot(session.id)
          return snapshot.events.some((item) => item.type === "intervention_injected")
        })
        expect(ready).toBe(true)

        const threads = await Aegis.workspaceThreads({
          session_id: session.id,
        })
        const hits = threads.items.filter((item) => item.fingerprint === `rule:${rule.id}`)
        expect(threads.items.length).toBeGreaterThan(0)
        expect(hits.length).toBe(1)
      },
    })
  })
})
