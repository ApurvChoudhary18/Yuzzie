/**
 * `yuzie completion bash|zsh|fish` (SPEC.md §18 Session 17) and the hidden
 * `yuzie __complete` it calls on every Tab.
 *
 * Commands, subcommands and flags come from the command tree itself, so they
 * are never out of date. Card numbers (with their titles) and column names
 * come from the local cache: no network, so completion is instant and works on
 * a plane.
 */

import { openCache } from '@yuzie/store'
import type { Command, Option } from 'commander'
import type { Context } from '../context.js'
import { UsageError } from '../exit.js'
import { currentSlug } from '../session.js'

export const SHELLS = ['bash', 'zsh', 'fish'] as const
type Shell = (typeof SHELLS)[number]

export function completionScript(shell: Shell): string {
  switch (shell) {
    case 'bash':
      return `# yuzie completion for bash. Add to ~/.bashrc:  eval "$(yuzie completion bash)"
_yuzie() {
  # Copy the words before changing IFS: bash 3.2 (macOS) joins a sliced array
  # expansion into one word when IFS is not the default.
  local words=("\${COMP_WORDS[@]:1}")
  local IFS=$'\\n'
  COMPREPLY=( $(yuzie __complete "$((COMP_CWORD - 1))" "\${words[@]}" 2>/dev/null | cut -f1) )
}
complete -o default -F _yuzie yuzie yz
`
    case 'zsh':
      return `#compdef yuzie yz
# yuzie completion for zsh. Add to ~/.zshrc:  eval "$(yuzie completion zsh)"
_yuzie() {
  local -a lines described
  lines=("\${(@f)$(yuzie __complete "$((CURRENT - 2))" "\${words[@]:1}" 2>/dev/null)}")
  local line
  for line in $lines; do
    [[ -z $line ]] && continue
    described+=("\${\${line%%$'\\t'*}//:/\\\\:}:\${line#*$'\\t'}")
  done
  _describe 'yuzie' described
}
compdef _yuzie yuzie yz
`
    case 'fish':
      return `# yuzie completion for fish. Add to ~/.config/fish/config.fish:  yuzie completion fish | source
function __yuzie_complete
  set -l words (commandline -opc)
  set -l current (commandline -ct)
  yuzie __complete (math (count $words) - 1) $words[2..-1] $current 2>/dev/null
end
complete -c yuzie -f -a '(__yuzie_complete)'
complete -c yz -f -a '(__yuzie_complete)'
`
  }
}

export async function completion(context: Context, shell: string): Promise<void> {
  if (!(SHELLS as readonly string[]).includes(shell))
    throw new UsageError(`No completion for "${shell}".`, `Use one of: ${SHELLS.join(', ')}.`)
  context.io.stdout.write(completionScript(shell as Shell))
}

/** One candidate: what to insert, and (zsh and fish show it) what it is. */
interface Candidate {
  readonly value: string
  readonly description: string
}

const PRIORITIES: Candidate[] = ['p0', 'p1', 'p2', 'p3', 'none'].map((value) => ({
  value,
  description: value === 'none' ? 'clear the priority' : `priority ${value.slice(1)}`,
}))

function longName(option: Option): string | undefined {
  return option.long ?? undefined
}

function visible(commands: readonly Command[]): Command[] {
  return commands.filter((command) => !(command as unknown as { _hidden?: boolean })._hidden)
}

/** Cards and columns for the board this directory uses, from the cache only. */
async function fromCache(context: Context): Promise<{ cards: Candidate[]; columns: Candidate[] }> {
  try {
    const slug = await currentSlug(context)
    const cache = openCache({
      boardSlug: slug,
      cwd: context.io.cwd,
      home: context.home,
      env: context.io.env,
    })
    try {
      const columns = cache.columns.list(slug)
      const names = new Map(columns.map((column) => [column.key, column.name]))
      return {
        cards: cache.cards
          .list(slug)
          .filter((card) => card.number > 0)
          .sort((a, b) => a.number - b.number)
          .map((card) => ({
            value: String(card.number),
            description: `${card.title} (${names.get(card.column) ?? card.column})`,
          })),
        columns: columns.map((column) => ({ value: column.key, description: column.name })),
      }
    } finally {
      cache.close()
    }
  } catch {
    // No board here, or no cache yet: nothing to suggest, and nothing to say about it.
    return { cards: [], columns: [] }
  }
}

/**
 * What to offer for word `index` of `words` (the words after `yuzie`; the one
 * being completed may be absent or partial).
 */
export async function candidates(
  context: Context,
  program: Command,
  index: number,
  words: readonly string[],
): Promise<Candidate[]> {
  const current = words[index] ?? ''
  let command = program
  let positional = 0
  let pendingOption: Option | undefined

  for (const word of words.slice(0, Math.max(0, index))) {
    if (pendingOption !== undefined) {
      pendingOption = undefined
      continue
    }
    if (word.startsWith('-')) {
      const option = [...command.options, ...program.options].find(
        (candidate) => candidate.long === word || candidate.short === word,
      )
      if (option !== undefined && (option.required || option.optional)) pendingOption = option
      continue
    }
    const sub = command.commands.find(
      (candidate) => candidate.name() === word || candidate.aliases().includes(word),
    )
    if (sub !== undefined && positional === 0) {
      command = sub
      continue
    }
    positional += 1
  }

  const cache = () => fromCache(context)
  let offered: Candidate[] = []
  if (pendingOption !== undefined) {
    const name = pendingOption.long ?? ''
    if (['--column', '--status'].includes(name)) offered = (await cache()).columns
    else if (name === '--priority') offered = PRIORITIES
    else if (name === '--sort')
      offered = ['updated', 'rank', 'created', 'due', 'priority'].map((value) => ({
        value,
        description: 'sort order',
      }))
  } else if (current.startsWith('-')) {
    offered = [...command.options, ...(command === program ? [] : program.options)]
      .map((option) => ({ value: longName(option) ?? '', description: option.description }))
      .filter((candidate) => candidate.value.length > 0)
  } else if (command.commands.length > 0 && positional === 0) {
    offered = visible(command.commands).map((sub) => ({
      value: sub.name(),
      description: sub.description(),
    }))
  } else {
    const declared = command.registeredArguments
    // A variadic last argument (`assign <id> [handles...]`) takes every word after it.
    const argument = declared[Math.min(positional, Math.max(0, declared.length - 1))]
    const name = argument?.name() ?? ''
    if (name === 'id' || name === 'ids') offered = (await cache()).cards
    else if (name === 'column' || name === 'key') offered = (await cache()).columns
    else if (name === 'priority') offered = PRIORITIES
    else if (name === 'shell')
      offered = SHELLS.map((value) => ({ value, description: `${value} completion` }))
  }
  return offered.filter((candidate) => candidate.value.startsWith(current))
}

export async function complete(
  context: Context,
  program: Command,
  index: string,
  words: readonly string[],
): Promise<void> {
  const at = Number(index)
  const found = await candidates(
    context,
    program,
    Number.isInteger(at) && at >= 0 ? at : words.length,
    words,
  )
  context.io.stdout.write(
    found
      .map((candidate) => `${candidate.value}\t${candidate.description.replace(/\s+/g, ' ')}`)
      .join('\n') + (found.length > 0 ? '\n' : ''),
  )
}
