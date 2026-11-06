/**
 * Turning a local `link:` plugin into a GitHub-restorable install spec.
 *
 * A plugin installed from a directory is normally not restorable on another
 * device. When that directory is a clean checkout of a single-package GitHub
 * repository with its built entry point committed and its HEAD pushed, it
 * effectively *is* installable — so the inventory records
 * `github:owner/repo#<commit>` instead of "a directory on my machine".
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectCheckout, parseGithubRemote, resolveRestorableCheckout } from '../../src/collect/plugins.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 4 * 1024 * 1024 })
  return result.stdout
}

interface RepoOptions {
  packageName?: string
  private?: boolean
  main?: string
  withLib?: boolean
}

/** Create a repo with an initial commit, a bare remote and a push. */
async function makeRepo(options: RepoOptions = {}): Promise<{ repo: string; bare: string; commit: string }> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-checkout-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const bare = join(root, 'remote.git')
  await mkdir(repo, { recursive: true })
  await git(root, ['init', '--bare', '-b', 'main', bare])
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'test'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])

  const manifest: Record<string, unknown> = {
    name: options.packageName ?? 'demo-plugin',
    version: '1.0.0',
    main: options.main ?? 'lib/index.js',
  }
  if (options.private === true) manifest.private = true
  await writeFile(join(repo, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (options.withLib !== false) {
    await mkdir(join(repo, 'lib'), { recursive: true })
    await writeFile(join(repo, 'lib', 'index.js'), 'export default function apply() {}\n', 'utf8')
  }
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'initial'])
  await git(repo, ['remote', 'add', 'origin', bare])
  await git(repo, ['push', '-u', 'origin', 'main'])
  const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim()
  return { repo, bare, commit }
}

describe('parseGithubRemote', () => {
  it('accepts the common GitHub URL shapes', () => {
    expect(parseGithubRemote('https://github.com/alfredhuang211/dsh-ssh-hosts.git')).toEqual({
      owner: 'alfredhuang211',
      repo: 'dsh-ssh-hosts',
    })
    expect(parseGithubRemote('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
    expect(parseGithubRemote('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
    expect(parseGithubRemote('ssh://git@github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('rejects anything that is not a GitHub repository URL', () => {
    expect(parseGithubRemote('')).toBeNull()
    expect(parseGithubRemote('https://gitlab.com/owner/repo.git')).toBeNull()
    expect(parseGithubRemote('file:///tmp/remote.git')).toBeNull()
    expect(parseGithubRemote('git@example.com:owner/repo.git')).toBeNull()
    expect(parseGithubRemote('https://github.com/owner')).toBeNull()
  })
})

describe('inspectCheckout', () => {
  it('reads commit, branch, pushed state, entry point and root-package shape', async () => {
    const { repo, commit } = await makeRepo()
    const facts = await inspectCheckout(repo, { packageName: 'demo-plugin' })
    expect(facts).not.toBeNull()
    expect(facts?.commit).toBe(commit)
    expect(facts?.branch).toBe('main')
    expect(facts?.pushed).toBe(true)
    expect(facts?.hasMain).toBe(true)
    expect(facts?.rootPackage).toBe(true)
    expect(facts?.relativeDir).toBe('')
    // The local remote is a file path, so there are no GitHub coordinates.
    expect(facts?.github).toBeNull()
  })

  it('reports an unpushed commit, a missing entry point and a monorepo root', async () => {
    const { repo } = await makeRepo()
    await writeFile(join(repo, 'extra.txt'), 'x\n', 'utf8')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-m', 'unpushed'])
    const unpushed = await inspectCheckout(repo, { packageName: 'demo-plugin' })
    expect(unpushed?.pushed).toBe(false)

    const missingEntry = await makeRepo({ withLib: false })
    const facts = await inspectCheckout(missingEntry.repo, { packageName: 'demo-plugin' })
    expect(facts?.hasMain).toBe(false)

    const monorepo = await makeRepo({ packageName: 'workspace-root' })
    const nested = await inspectCheckout(monorepo.repo, { packageName: 'demo-plugin' })
    expect(nested?.rootPackage).toBe(false)
  })

  it('returns null for a directory that is not a git checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-checkout-'))
    roots.push(root)
    expect(await inspectCheckout(root, { packageName: 'demo-plugin' })).toBeNull()
  })
})

describe('resolveRestorableCheckout', () => {
  it('produces a pinned github spec for a clean, pushed, single-package checkout', async () => {
    const { repo, commit } = await makeRepo()
    // Point origin at a GitHub URL after the push, so the whole chain
    // (remote parse included) is exercised without any network access.
    await git(repo, ['remote', 'set-url', 'origin', 'https://github.com/alfredhuang211/demo-plugin.git'])
    const spec = await resolveRestorableCheckout('demo-plugin', repo)
    expect(spec).toEqual({
      source: 'github:alfredhuang211/demo-plugin#main',
      installSpec: `github:alfredhuang211/demo-plugin#${commit}`,
    })
  })

  it('uses pnpm path: selector for a package inside a monorepo', async () => {
    // A workspace repo: root package is private and different, the plugin lives
    // in packages/<name> with its built entry point committed.
    const root = await mkdtemp(join(tmpdir(), 'plugin-checkout-'))
    roots.push(root)
    const repo = join(root, 'mono')
    const bare = join(root, 'mono-remote.git')
    await mkdir(join(repo, 'packages', 'demo-plugin', 'lib'), { recursive: true })
    await git(root, ['init', '--bare', '-b', 'main', bare])
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['config', 'user.name', 'test'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await git(repo, ['config', 'commit.gpgsign', 'false'])
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'workspace-root', private: true, workspaces: ['packages/*'] }, null, 2),
      'utf8',
    )
    await writeFile(
      join(repo, 'packages', 'demo-plugin', 'package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '2.0.0', main: 'lib/index.js' }, null, 2),
      'utf8',
    )
    await writeFile(join(repo, 'packages', 'demo-plugin', 'lib', 'index.js'), 'export default function apply() {}\n', 'utf8')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-m', 'initial'])
    await git(repo, ['remote', 'add', 'origin', bare])
    await git(repo, ['push', '-u', 'origin', 'main'])
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await git(repo, ['remote', 'set-url', 'origin', 'https://github.com/alfredhuang211/demo-mono.git'])

    const spec = await resolveRestorableCheckout('demo-plugin', join(repo, 'packages', 'demo-plugin'))
    expect(spec).toEqual({
      source: 'github:alfredhuang211/demo-mono#main&path:/packages/demo-plugin',
      installSpec: `github:alfredhuang211/demo-mono#${commit}&path:/packages/demo-plugin`,
    })
  })

  it('refuses when the commit is not on GitHub, the entry point is missing, or the package name differs', async () => {
    const { repo } = await makeRepo()
    await git(repo, ['remote', 'set-url', 'origin', 'https://github.com/alfredhuang211/demo-plugin.git'])
    await writeFile(join(repo, 'more.txt'), 'x\n', 'utf8')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-m', 'local only'])
    expect(await resolveRestorableCheckout('demo-plugin', repo)).toBeNull()

    const noEntry = await makeRepo({ withLib: false })
    await git(noEntry.repo, ['remote', 'set-url', 'origin', 'https://github.com/alfredhuang211/x.git'])
    expect(await resolveRestorableCheckout('demo-plugin', noEntry.repo)).toBeNull()

    const wrongName = await makeRepo({ packageName: 'some-other-plugin' })
    await git(wrongName.repo, ['remote', 'set-url', 'origin', 'https://github.com/alfredhuang211/y.git'])
    expect(await resolveRestorableCheckout('demo-plugin', wrongName.repo)).toBeNull()
  })
})
