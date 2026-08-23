/** Entrada de línea de comandos: `npm run db:seed [-- --reset]`. */
import './load-env'
import { db } from './index'
import { type SeedDb, runSeed } from './seed'

runSeed(db as unknown as SeedDb, {
  reset: process.argv.includes('--reset'),
  log: (line) => console.log(line),
})
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed fallido:', err)
    process.exit(1)
  })
