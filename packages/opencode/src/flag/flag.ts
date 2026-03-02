function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const AEGIS_AUTO_SHARE = truthy("AEGIS_AUTO_SHARE")
  export const AEGIS_GIT_BASH_PATH = process.env["AEGIS_GIT_BASH_PATH"]
  export const AEGIS_CONFIG = process.env["AEGIS_CONFIG"]
  export declare const AEGIS_CONFIG_DIR: string | undefined
  export const AEGIS_CONFIG_CONTENT = process.env["AEGIS_CONFIG_CONTENT"]
  export const AEGIS_DISABLE_AUTOUPDATE = truthy("AEGIS_DISABLE_AUTOUPDATE")
  export const AEGIS_DISABLE_PRUNE = truthy("AEGIS_DISABLE_PRUNE")
  export const AEGIS_DISABLE_TERMINAL_TITLE = truthy("AEGIS_DISABLE_TERMINAL_TITLE")
  export const AEGIS_PERMISSION = process.env["AEGIS_PERMISSION"]
  export const AEGIS_DISABLE_DEFAULT_PLUGINS = truthy("AEGIS_DISABLE_DEFAULT_PLUGINS")
  export const AEGIS_DISABLE_LSP_DOWNLOAD = truthy("AEGIS_DISABLE_LSP_DOWNLOAD")
  export const AEGIS_ENABLE_EXPERIMENTAL_MODELS = truthy("AEGIS_ENABLE_EXPERIMENTAL_MODELS")
  export const AEGIS_DISABLE_AUTOCOMPACT = truthy("AEGIS_DISABLE_AUTOCOMPACT")
  export const AEGIS_DISABLE_MODELS_FETCH = truthy("AEGIS_DISABLE_MODELS_FETCH")
  export const AEGIS_DISABLE_CLAUDE_CODE = truthy("AEGIS_DISABLE_CLAUDE_CODE")
  export const AEGIS_DISABLE_CLAUDE_CODE_PROMPT =
    AEGIS_DISABLE_CLAUDE_CODE || truthy("AEGIS_DISABLE_CLAUDE_CODE_PROMPT")
  export const AEGIS_DISABLE_CLAUDE_CODE_SKILLS =
    AEGIS_DISABLE_CLAUDE_CODE || truthy("AEGIS_DISABLE_CLAUDE_CODE_SKILLS")
  export const AEGIS_DISABLE_EXTERNAL_SKILLS =
    AEGIS_DISABLE_CLAUDE_CODE_SKILLS || truthy("AEGIS_DISABLE_EXTERNAL_SKILLS")
  export declare const AEGIS_DISABLE_PROJECT_CONFIG: boolean
  export const AEGIS_FAKE_VCS = process.env["AEGIS_FAKE_VCS"]
  export declare const AEGIS_CLIENT: string
  export const AEGIS_SERVER_PASSWORD = process.env["AEGIS_SERVER_PASSWORD"]
  export const AEGIS_SERVER_USERNAME = process.env["AEGIS_SERVER_USERNAME"]
  export const AEGIS_ENABLE_QUESTION_TOOL = truthy("AEGIS_ENABLE_QUESTION_TOOL")

  // Experimental
  export const AEGIS_EXPERIMENTAL = truthy("AEGIS_EXPERIMENTAL")
  export const AEGIS_EXPERIMENTAL_FILEWATCHER = truthy("AEGIS_EXPERIMENTAL_FILEWATCHER")
  export const AEGIS_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("AEGIS_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const AEGIS_EXPERIMENTAL_ICON_DISCOVERY =
    AEGIS_EXPERIMENTAL || truthy("AEGIS_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["AEGIS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const AEGIS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("AEGIS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const AEGIS_ENABLE_EXA =
    truthy("AEGIS_ENABLE_EXA") || AEGIS_EXPERIMENTAL || truthy("AEGIS_EXPERIMENTAL_EXA")
  export const AEGIS_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("AEGIS_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const AEGIS_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("AEGIS_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const AEGIS_EXPERIMENTAL_OXFMT = AEGIS_EXPERIMENTAL || truthy("AEGIS_EXPERIMENTAL_OXFMT")
  export const AEGIS_EXPERIMENTAL_LSP_TY = truthy("AEGIS_EXPERIMENTAL_LSP_TY")
  export const AEGIS_EXPERIMENTAL_LSP_TOOL = AEGIS_EXPERIMENTAL || truthy("AEGIS_EXPERIMENTAL_LSP_TOOL")
  export const AEGIS_DISABLE_FILETIME_CHECK = truthy("AEGIS_DISABLE_FILETIME_CHECK")
  export const AEGIS_EXPERIMENTAL_PLAN_MODE = AEGIS_EXPERIMENTAL || truthy("AEGIS_EXPERIMENTAL_PLAN_MODE")
  export const AEGIS_EXPERIMENTAL_MARKDOWN = truthy("AEGIS_EXPERIMENTAL_MARKDOWN")
  export const AEGIS_MODELS_URL = process.env["AEGIS_MODELS_URL"]
  export const AEGIS_MODELS_PATH = process.env["AEGIS_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for AEGIS_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "AEGIS_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("AEGIS_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AEGIS_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "AEGIS_CONFIG_DIR", {
  get() {
    return process.env["AEGIS_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AEGIS_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "AEGIS_CLIENT", {
  get() {
    return process.env["AEGIS_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
