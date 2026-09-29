/** Run the stub API as its own process (so a blocked caller cannot starve it); prints its URL. */
import { startStub } from './stub-server.mjs'

const stub = await startStub({ cards: Number(process.argv[2] ?? 200) })
process.stdout.write(`${stub.baseUrl}\n`)
process.on('SIGTERM', () => void stub.close().then(() => process.exit(0)))
