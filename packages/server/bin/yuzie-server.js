#!/usr/bin/env node
// The Yuzie server (SPEC.md §10): `npx @yuzie/server`, or `yuzie serve`.
// Configured by environment variables; DATABASE_URL is required. See
// docs/self-hosting.md.
import { start } from '../dist/index.js'

start().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
