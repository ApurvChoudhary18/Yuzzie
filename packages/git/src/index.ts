/**
 * @yuzie/git — Git repository introspection: branches, commits, hooks, and editor resolution.
 *
 * Session 6 adds what `yuzie init` needs: finding the repository, reading its
 * remote and default branch, and installing hooks. Branches, commits and the
 * derived git summary arrive in Session 11 (SPEC.md §18).
 */
export const PACKAGE_NAME = '@yuzie/git' as const

export {
  HOOK_NAMES,
  type HookName,
  type HookState,
  type HookStatus,
  hookBlock,
  hookStatus,
  type InstallResult,
  installHooks,
  uninstallHooks,
} from './hooks.js'
export { parseRemote, type Remote } from './remote.js'
export {
  defaultBranch,
  findRepo,
  type GitResult,
  git,
  gitVersion,
  hooksDirectory,
  type Repo,
} from './repo.js'
