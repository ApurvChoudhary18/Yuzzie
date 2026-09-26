/**
 * Branch operations for `claim` and `start` (SPEC.md §9.2, §9.3).
 *
 * If the branch exists locally it is checked out; if it exists on the remote
 * it is fetched and tracked; otherwise it is created from the base. Nothing
 * here ever deletes or resets anything: Git is never rolled back.
 */
import { git, resolveRef } from './repo.js'

export async function localBranchExists(root: string, name: string): Promise<boolean> {
  return (await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0
}

/** Whether `remote` has the branch, asking the remote itself (it may be ahead of our refs). */
export async function remoteBranchExists(
  root: string,
  name: string,
  remote = 'origin',
): Promise<boolean> {
  const remotes = await git(root, ['remote'])
  if (remotes.code !== 0 || !remotes.stdout.split('\n').includes(remote)) return false
  const listed = await git(root, ['ls-remote', '--exit-code', '--heads', remote, name])
  return listed.code === 0 && listed.stdout.length > 0
}

export type BranchAction =
  /** Created from the base and checked out. */
  | 'created'
  /** Already existed here: checked out. */
  | 'checked-out'
  /** Existed on the remote: fetched, created locally tracking it, checked out. */
  | 'tracked'
  /** Already the current branch. */
  | 'current'

export class BranchError extends Error {}

/** The commit to branch from: the base itself, else its remote-tracking twin. */
export async function baseRef(root: string, base: string, remote = 'origin'): Promise<string> {
  if ((await resolveRef(root, base)) !== null) return base
  const tracking = `${remote}/${base}`
  if ((await resolveRef(root, tracking)) !== null) return tracking
  throw new BranchError(`Base branch "${base}" does not exist here or on ${remote}.`)
}

/** Get onto `name`: check it out, track it, or create it from `base`. */
export async function switchToBranch(
  root: string,
  name: string,
  base: string,
  options: { remote?: string; current?: string | null } = {},
): Promise<BranchAction> {
  const remote = options.remote ?? 'origin'
  if (options.current === name) return 'current'

  if (await localBranchExists(root, name)) {
    const checkout = await git(root, ['checkout', name])
    if (checkout.code !== 0)
      throw new BranchError(checkout.stderr || `Could not check out ${name}.`)
    return 'checked-out'
  }

  if (await remoteBranchExists(root, name, remote)) {
    const fetch = await git(root, ['fetch', remote, `${name}:refs/remotes/${remote}/${name}`])
    if (fetch.code !== 0) throw new BranchError(fetch.stderr || `Could not fetch ${name}.`)
    const track = await git(root, ['checkout', '-b', name, '--track', `${remote}/${name}`])
    if (track.code !== 0) throw new BranchError(track.stderr || `Could not track ${name}.`)
    return 'tracked'
  }

  const from = await baseRef(root, base, remote)
  const create = await git(root, ['checkout', '-b', name, from])
  if (create.code !== 0) throw new BranchError(create.stderr || `Could not create ${name}.`)
  return 'created'
}

/** Stash everything, untracked files too, with a message saying why. */
export async function stash(root: string, message: string): Promise<boolean> {
  const result = await git(root, ['stash', 'push', '--include-untracked', '--message', message])
  return result.code === 0
}

/** Push `branch` and set its upstream (`finish --push`). */
export async function pushBranch(
  root: string,
  branch: string,
  remote = 'origin',
): Promise<{ ok: boolean; error: string }> {
  const result = await git(root, ['push', '--set-upstream', remote, branch])
  return { ok: result.code === 0, error: result.stderr }
}
