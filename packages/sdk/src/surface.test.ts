/**
 * Two properties of the *built* package that §13.1 and §18 Session 5 require:
 *
 *   - the core entry has no Node-only imports, so it runs in a browser;
 *   - the public API has zero `any`.
 *
 * Both are checked on `dist/`, because that is what a consumer gets.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

async function bundleForBrowser(entry: string) {
  return build({
    entryPoints: [join(DIST, entry)],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    metafile: true,
  })
}

describe('the core entry', () => {
  it('bundles for a browser with no Node built-ins anywhere in its graph', async () => {
    const result = await bundleForBrowser('index.js')
    const inputs = Object.keys(result.metafile.inputs)
    expect(
      inputs.some((input) => input.includes('@yuzie/store') || input.includes('store/dist')),
    ).toBe(false)
    expect(result.outputFiles[0]?.text).not.toMatch(/require\(["'](fs|child_process|os|path)["']\)/)
  })

  it('is a check that can fail: the Node entry, which reads files, does not bundle for a browser', async () => {
    await expect(bundleForBrowser('node.js')).rejects.toThrow(/child_process|fs|os|path/)
  })
})

describe('the public types', () => {
  /** Declarations with comments removed, so prose like "for any reason" is not flagged. */
  function declarations(): Array<{ file: string; code: string }> {
    return readdirSync(DIST)
      .filter((file) => file.endsWith('.d.ts'))
      .map((file) => ({
        file,
        code: readFileSync(join(DIST, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, ''),
      }))
  }

  it('declare both entries', () => {
    expect(declarations().map((d) => d.file)).toEqual(
      expect.arrayContaining(['index.d.ts', 'node.d.ts']),
    )
  })

  it('contain no `any`', () => {
    for (const { file, code } of declarations()) {
      const offenders = code.split('\n').filter((line) => /\bany\b/.test(line))
      expect(offenders, file).toEqual([])
    }
  })
})
