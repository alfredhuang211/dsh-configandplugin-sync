/**
 * Small filesystem helpers shared by the state layer and the local applier.
 *
 * Every write this plugin performs into the DSH home is atomic (temp file +
 * rename) and private (`0600` files, `0700` directories): a half-written patch
 * file would break the Loader at the next boot, and this plugin stores paths
 * and credentials that no other local user should read.
 * @module core/fs
 */

import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomToken } from './hash.js'

/** Read a UTF-8 file, returning null when it does not exist or cannot be read. */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Whether a path exists. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Create a directory tree with private permissions. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  try {
    await chmod(path, 0o700)
  } catch {
    // A shared filesystem or an existing mount may refuse the change; the
    // recursive mkdir above already applied the mode where it could.
  }
}

/** Write a UTF-8 file atomically with private permissions. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await ensurePrivateDir(dirname(path))
  const temporary = join(dirname(path), `.${randomToken(6)}.tmp`)
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  try {
    await chmod(path, 0o600)
  } catch {
    // Best effort, as above.
  }
}

/** Write a file only when its content differs; returns whether it changed. */
export async function writeFileIfChanged(path: string, content: string): Promise<boolean> {
  const current = await readTextFile(path)
  if (current === content) return false
  await writePrivateFile(path, content)
  return true
}

/** Remove a file, ignoring a missing target. */
export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** List a directory's entry names, returning [] when it is missing. */
export async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

/** Write bytes to a path, creating parent directories (used for work trees). */
export async function writeBytes(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}
