import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const sourceRoot = join(root, 'src')
const forbiddenPatterns = [
  /\bnew\s+Function\s*\(/,
  /\beval\s*\(/,
  /(?<!interface\s+)\bFunction\s*\(/,
]

function walk(directory, findings) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, findings)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue

    const stats = statSync(fullPath)
    if (stats.size > 1024 * 1024) continue

    const lines = readFileSync(fullPath, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (forbiddenPatterns.some((pattern) => pattern.test(line))) {
        findings.push(`${relative(root, fullPath)}:${index + 1}: ${line.trim()}`)
      }
    })
  }
}

const findings = []
walk(sourceRoot, findings)

if (findings.length) {
  console.error('Execucao dinamica de string bloqueada em codigo de producao:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exit(1)
}

console.log('Nenhum eval/new Function/Function constructor encontrado em src de producao.')
