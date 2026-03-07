import { describe, expect, mock, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("server security", () => {
  test("returns 404 for sessions outside the active project", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: first.path,
      fn: async () => Session.create({ title: "first" }),
    })

    await Instance.provide({
      directory: second.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request(`/session/${session.id}`)
        expect(response.status).toBe(404)
      },
    })
  })

  test("disables experimental global session listing", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/experimental/session")
        expect(response.status).toBe(404)
      },
    })
  })

  test("redacts secrets from config endpoints", async () => {
    const config = {
      provider: {
        openai: {
          npm: "@ai-sdk/openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          options: {
            apiKey: "secret-key",
          },
        },
      },
      mcp: {
        secure: {
          type: "remote" as const,
          url: "https://mcp.example.com",
          headers: {
            Authorization: "Bearer secret",
          },
          oauth: {
            clientId: "client",
            clientSecret: "secret",
          },
        },
      },
    }
    const originalGet = Config.get
    const originalGetGlobal = Config.getGlobal
    Config.get = mock(async () => config)
    Config.getGlobal = mock(async () => config)

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.App()

          const local = await app.request("/config")
          expect(local.status).toBe(200)
          const localBody = await local.json()
          expect(localBody.provider.openai.options.apiKey).toBeUndefined()
          expect(localBody.provider.openai.options.apiKeyConfigured).toBe(true)
          expect(localBody.mcp.secure.headers).toBeUndefined()
          expect(localBody.mcp.secure.headerKeys).toEqual(["Authorization"])
          expect(localBody.mcp.secure.oauth.clientSecret).toBeUndefined()
          expect(localBody.mcp.secure.oauth.clientSecretConfigured).toBe(true)

          const global = await app.request("/global/config")
          expect(global.status).toBe(200)
          const globalBody = await global.json()
          expect(globalBody.provider.openai.options.apiKey).toBeUndefined()
          expect(globalBody.mcp.secure.headers).toBeUndefined()
        },
      })
    } finally {
      Config.get = originalGet
      Config.getGlobal = originalGetGlobal
    }
  })

  test("strips sensitive headers from fallback proxy requests", async () => {
    const originalFetch = globalThis.fetch
    let request: Request | undefined
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init)
      return new Response("ok", {
        status: 200,
        headers: {
          "content-type": "text/plain",
        },
      })
    }) as unknown as typeof fetch

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.App()
          const response = await app.request("/proxy-check", {
            headers: {
              Accept: "text/plain",
              Authorization: "Basic secret",
              Cookie: "token=secret",
              "X-Aegis-Directory": tmp.path,
            },
          })
          expect(response.status).toBe(200)
        },
      })
      expect(request?.headers.get("accept")).toBe("text/plain")
      expect(request?.headers.get("authorization")).toBeNull()
      expect(request?.headers.get("cookie")).toBeNull()
      expect(request?.headers.get("x-aegis-directory")).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
