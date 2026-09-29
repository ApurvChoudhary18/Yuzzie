import { describe, expect, it } from 'vitest'
import { CardCreateRequestSchema, CommentCreateRequestSchema } from './schema.js'
import { codePoint, firstControlCharacter, printable } from './text.js'

describe('control characters (§18 Session 16)', () => {
  it('finds C0, DEL and C1 controls; multi-line text may keep newlines and tabs', () => {
    expect(firstControlCharacter('plain text', false)).toBeNull()
    expect(firstControlCharacter('emoji 🧪 漢字 עברית', false)).toBeNull()
    expect(firstControlCharacter('a\u001b[2J', false)).toBe('\u001b')
    expect(firstControlCharacter('\u009b31m', false)).toBe('\u009b')
    expect(firstControlCharacter('del\u007f', false)).toBe('\u007f')
    expect(firstControlCharacter('two\nlines', false)).toBe('\n')
    expect(firstControlCharacter('two\nlines\tand a tab', true)).toBeNull()
    expect(firstControlCharacter('carriage\rreturn', true)).toBe('\r')
    expect(codePoint('\u001b')).toBe('U+001B')
  })

  it('printable shows them as � and leaves everything else alone', () => {
    expect(printable('\u001b]0;pwned\u0007 title')).toBe('�]0;pwned� title')
    expect(printable('a\nb\tc', { multiline: true })).toBe('a\nb\tc')
    expect(printable('a\nb')).toBe('a�b')
    expect(printable('🧪 é')).toBe('🧪 é')
  })

  it('requests refuse them with a message that names the character', () => {
    const title = CardCreateRequestSchema.safeParse({ title: 'x\u001b[2J' })
    expect(title.success).toBe(false)
    expect(title.error?.issues[0]?.message).toContain('U+001B')
    expect(CardCreateRequestSchema.safeParse({ title: 'one\ntwo' }).success).toBe(false)
    expect(
      CardCreateRequestSchema.safeParse({ title: 'ok', description: 'line one\nline two' }).success,
    ).toBe(true)
    expect(CommentCreateRequestSchema.safeParse({ body: 'nul\u0000here' }).success).toBe(false)
    expect(CommentCreateRequestSchema.safeParse({ body: 'fine\n\tindented' }).success).toBe(true)
  })
})
