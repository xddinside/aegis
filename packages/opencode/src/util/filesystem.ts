import { chmod, mkdir, readFile, writeFile } from "fs/promises"
import { createWriteStream, existsSync, statSync } from "fs"
import { lookup } from "mime-types"
import { realpathSync } from "fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "path"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { Glob } from "./glob"

export namespace Filesystem {
  // Fast sync version for metadata checks
  export async function exists(p: string): Promise<boolean> {
    return existsSync(p)
  }

  export async function isDir(p: string): Promise<boolean> {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }

  export function stat(p: string): ReturnType<typeof statSync> | undefined {
    return statSync(p, { throwIfNoEntry: false }) ?? undefined
  }

  export async function size(p: string): Promise<number> {
    const s = stat(p)?.size ?? 0
    return typeof s === "bigint" ? Number(s) : s
  }

  export async function readText(p: string): Promise<string> {
    return readFile(p, "utf-8")
  }

  export async function readJson<T = any>(p: string): Promise<T> {
    return JSON.parse(await readFile(p, "utf-8"))
  }

  export async function readBytes(p: string): Promise<Buffer> {
    return readFile(p)
  }

  export async function readArrayBuffer(p: string): Promise<ArrayBuffer> {
    const buf = await readFile(p)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  }

  function isEnoent(e: unknown): e is { code: "ENOENT" } {
    return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "ENOENT"
  }

  export async function write(p: string, content: string | Buffer | Uint8Array, mode?: number): Promise<void> {
    try {
      if (mode) {
        await writeFile(p, content, { mode })
      } else {
        await writeFile(p, content)
      }
    } catch (e) {
      if (isEnoent(e)) {
        await mkdir(dirname(p), { recursive: true })
        if (mode) {
          await writeFile(p, content, { mode })
        } else {
          await writeFile(p, content)
        }
        return
      }
      throw e
    }
  }

  export async function writeJson(p: string, data: unknown, mode?: number): Promise<void> {
    return write(p, JSON.stringify(data, null, 2), mode)
  }

  export async function writeStream(
    p: string,
    stream: ReadableStream<Uint8Array> | Readable,
    mode?: number,
  ): Promise<void> {
    const dir = dirname(p)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    const nodeStream = stream instanceof ReadableStream ? Readable.fromWeb(stream as any) : stream
    const writeStream = createWriteStream(p)
    await pipeline(nodeStream, writeStream)

    if (mode) {
      await chmod(p, mode)
    }
  }

  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  /**
   * On Windows, normalize a path to its canonical casing using the filesystem.
   * This is needed because Windows paths are case-insensitive but LSP servers
   * may return paths with different casing than what we send them.
   */
  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return (
      p
        // Git Bash for Windows paths are typically /<drive>/...
        .replace(/^\/([a-zA-Z])\//, (_, drive) => `${drive.toUpperCase()}:/`)
        // Cygwin git paths are typically /cygdrive/<drive>/...
        .replace(/^\/cygdrive\/([a-zA-Z])\//, (_, drive) => `${drive.toUpperCase()}:/`)
        // WSL paths are typically /mnt/<drive>/...
        .replace(/^\/mnt\/([a-zA-Z])\//, (_, drive) => `${drive.toUpperCase()}:/`)
    )
  }

  function real(p: string) {
    return process.platform === "win32" ? realpathSync.native(p) : realpathSync(p)
  }

  export function canonical(p: string) {
    const resolved = windowsPath(resolve(p))
    if (existsSync(resolved)) {
      return normalizePath(real(resolved))
    }

    const parts = [basename(resolved)]
    let current = dirname(resolved)
    while (true) {
      if (existsSync(current)) {
        return normalizePath(join(real(current), ...parts))
      }
      const parent = dirname(current)
      if (parent === current) return
      parts.unshift(basename(current))
      current = parent
    }
  }

  export function overlaps(a: string, b: string) {
    const left = canonical(a)
    const right = canonical(b)
    if (!left || !right) return false
    const relA = relative(left, right)
    const relB = relative(right, left)
    return !relA || !relA.startsWith("..") || !relB || !relB.startsWith("..")
  }

  export function contains(parent: string, child: string) {
    const base = canonical(parent)
    const target = canonical(child)
    if (!base || !target) return false
    const rel = relative(base, target)
    if (!rel) return true
    if (isAbsolute(rel)) return false
    return !rel.startsWith("..")
  }

  export async function findUp(target: string, start: string, stop?: string) {
    let current = start
    const result = []
    while (true) {
      const search = join(current, target)
      if (await exists(search)) result.push(search)
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  export async function* up(options: { targets: string[]; start: string; stop?: string }) {
    const { targets, start, stop } = options
    let current = start
    while (true) {
      for (const target of targets) {
        const search = join(current, target)
        if (await exists(search)) yield search
      }
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  export async function globUp(pattern: string, start: string, stop?: string) {
    let current = start
    const result = []
    while (true) {
      try {
        const matches = await Glob.scan(pattern, {
          cwd: current,
          absolute: true,
          include: "file",
          dot: true,
        })
        result.push(...matches)
      } catch {
        // Skip invalid glob patterns
      }
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }
}
