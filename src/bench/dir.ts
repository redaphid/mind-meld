import path from 'node:path'

// Queries, judgments and runs quote a personal index, and this repository is
// public, so the bench directory must be named explicitly and must sit outside
// the repository. There is no default.
export const resolveBenchDir = (requested: string | undefined, repoRoot: string): string => {
  if (!requested) throw new Error('Name the bench directory with --dir or MINDMELD_BENCH_DIR; there is no default.')
  const dir = path.resolve(requested)
  const relative = path.relative(path.resolve(repoRoot), dir)
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (inside) throw new Error(`Refusing bench directory inside the repository (${relative || '.'}): it holds personal data.`)
  return dir
}
