import { describe, expect, it } from 'vitest'
import { cells, glyphs, head, sliceCells } from './cells.js'

describe('terminal cells', () => {
  it('counts a wide character as two cells and a combining accent as none', () => {
    expect(cells('abc')).toBe(3)
    expect(cells('●✓…│─')).toBe(5)
    expect(cells('🚀')).toBe(2)
    expect(cells('日本語')).toBe(6)
    expect(cells('é')).toBe(1)
    expect(cells('👩‍💻')).toBe(2)
  })

  it('splits text into what the terminal draws as one character', () => {
    expect(glyphs('a🚀é')).toEqual([
      { text: 'a', cells: 1 },
      { text: '🚀', cells: 2 },
      { text: 'é', cells: 1 },
    ])
  })

  it('takes the longest start that fits, never half a wide character', () => {
    expect(head('日本語', 4)).toBe('日本')
    expect(head('日本語', 3)).toBe('日')
    expect(head('ab🚀', 3)).toBe('ab')
    expect(head('plain', 3)).toBe('pla')
  })

  it('slices by cell, drawing a wide character the cut goes through as spaces', () => {
    expect(sliceCells('a日b', 1, 3)).toBe('日')
    expect(sliceCells('a日b', 0, 2)).toBe('a ')
    expect(sliceCells('a日b', 2, 4)).toBe(' b')
    expect(cells(sliceCells('🚀🚀🚀', 1, 4))).toBe(3)
  })
})
