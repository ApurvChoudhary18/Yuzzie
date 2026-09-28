/**
 * From card to code (SPEC.md §9.7, Journey F §6.6): `yuzie anchor` records a
 * file and line on a card; `yuzie open` goes there — the editor at the line,
 * or the branch's PR or compare view, or a link on the card.
 */
import { AnchorError, normaliseAnchor, resolveRef } from '@yuzie/git'
import type { Context } from '../context.js'
import { UsageError } from '../exit.js'
import { canLaunch, describeTarget, editorTarget, launch, staleness, webTarget } from '../open.js'
import { type BoardSession, withBoard } from '../session.js'
import { parseAnchor } from './cards.js'

function meta(session: BoardSession, extra: Record<string, unknown> = {}) {
  return {
    boardSlug: session.slug,
    synced: session.online && session.board.queued === 0,
    queued: session.board.queued,
    ...extra,
  }
}

/** `yuzie anchor <id> <file:line[-endLine]>` */
export async function anchor(context: Context, reference: string, location: string): Promise<void> {
  const repo = await context.repo()
  if (repo === null) {
    throw new UsageError(
      'Anchors point into a repository, and this is not one.',
      'Run it from inside the repository the card is about.',
    )
  }
  const parsed = parseAnchor(location)
  let normalised: Awaited<ReturnType<typeof normaliseAnchor>>
  try {
    normalised = await normaliseAnchor(repo.root, context.io.cwd, parsed)
  } catch (error) {
    if (error instanceof AnchorError)
      throw new UsageError(
        error.message,
        'Use a file in this repository, e.g. src/auth/oauth.ts:42.',
      )
    throw error
  }
  const commitSha = await resolveRef(repo.root, 'HEAD')

  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    await session.board.cards.setAnchor(card.number, {
      path: normalised.path,
      ...(normalised.line === null ? {} : { line: normalised.line }),
      ...(normalised.endLine === null ? {} : { endLine: normalised.endLine }),
      ...(commitSha === null ? {} : { commitSha }),
      primary: true,
    })
    const where = `${normalised.path}${normalised.line === null ? '' : `:${normalised.line}`}${normalised.endLine === null ? '' : `-${normalised.endLine}`}`
    context.output.success(`#${card.number} anchored at ${where}`)
    const updated = session.board.state.cards[card.number] ?? card
    context.output.result('Card', updated, meta(session))
  })
}

/** `yuzie open <id> [--github | --pr | --browser]` */
export async function open(
  context: Context,
  reference: string,
  options: { github?: boolean; pr?: boolean; browser?: boolean },
): Promise<void> {
  const chosen = [options.github, options.pr, options.browser].filter((flag) => flag === true)
  if (chosen.length > 1) throw new UsageError('Pick one of --github, --pr and --browser.')
  const { config } = await context.config()
  const env = context.io.env

  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const repo = await context.repo()
    const page = options.pr === true ? 'pr' : options.browser === true ? 'browser' : 'github'
    const target =
      chosen.length === 0
        ? editorTarget(card, repo, env)
        : await webTarget(card, repo, env, page, { baseBranch: config.git.baseBranch })

    if (target.kind === 'editor' && (await staleness(repo, card)) === true)
      context.output.warn('anchor may be stale (file changed since)')
    if (options.pr === true && target.kind === 'url' && target.page !== 'pr')
      context.output.warn(`No pull request for ${card.git?.branch}: opening the compare view`)

    const stdoutIsTTY = (context.io.stdout as { isTTY?: boolean }).isTTY === true
    const launched =
      !context.output.json && canLaunch(env, stdoutIsTTY) && env.YUZIE_NO_BROWSER !== '1'
    if (launched) {
      if (target.kind === 'url') context.output.line(`→ Opening ${target.url}`)
      await launch(target, env)
    } else {
      // No terminal to hand over, or CI: say where it would go, open nothing.
      context.output.line(describeTarget(target))
    }
    context.output.result(
      'Open',
      {
        number: card.number,
        kind: target.kind === 'editor' ? 'editor' : target.page,
        target: describeTarget(target),
        launched,
      },
      meta(session),
    )
  })
}
