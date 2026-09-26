/**
 * @yuzie/git — Git repository introspection: branches, commits, hooks, and editor resolution.
 *
 * Session 6 adds what `yuzie init` needs: finding the repository, reading its
 * remote and default branch, and installing hooks. Branches, commits and the
 * derived git summary arrive in Session 11 (SPEC.md §18).
 */
export const PACKAGE_NAME = '@yuzie/git' as const

export {
  type BranchAction,
  BranchError,
  baseRef,
  localBranchExists,
  pushBranch,
  remoteBranchExists,
  stash,
  switchToBranch,
} from './branch.js'
export {
  type BranchSummary,
  commitAt,
  commitsBetween,
  type DiffStats,
  diffStats,
  type ParsedCommit,
  summarize,
  type UpstreamState,
  upstreamState,
} from './commits.js'
export {
  DETECTED_EDITORS,
  type EditorCommand,
  EditorNotFoundError,
  lineArgs,
  onPath,
  resolveEditor,
  splitCommand,
} from './editor.js'
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
  currentBranch,
  defaultBranch,
  dirtyFiles,
  findRepo,
  type GitResult,
  git,
  gitVersion,
  type Head,
  head,
  hooksDirectory,
  type Repo,
  resolveRef,
} from './repo.js'
export {
  cardForCommit,
  cardFromBranch,
  type Resolution,
  type ResolutionRule,
} from './resolve.js'
