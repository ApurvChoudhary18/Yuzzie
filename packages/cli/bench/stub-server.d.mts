import type { Card, Column } from '@yuzie/core'

export declare const SLUG: string
export declare const TOKEN: string
export declare const COLUMNS: Column[]
export declare function makeCards(count: number): Card[]
export declare function startStub(options?: { cards?: number }): Promise<{
  baseUrl: string
  cards: Card[]
  close(): Promise<void>
}>
export declare function benchDirectories(): { home: string; cwd: string }
export declare function benchEnv(baseUrl: string, home: string): Record<string, string | undefined>
