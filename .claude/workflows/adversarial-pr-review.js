export const meta = {
  name: 'adversarial-pr-review',
  description: 'Multi-lens adversarial review of a PR: parallel reviewers, cross-refuted findings, verdict',
  whenToUse: 'High-risk PRs (schema, data-path, security). Pass {pr: <number>} as args.',
  phases: [
    { title: 'Review', detail: 'independent reviewers, one lens each' },
    { title: 'Refute', detail: 'each finding attacked by skeptics' },
    { title: 'Verdict', detail: 'synthesize surviving findings' },
  ],
}

// args: { pr: number, lenses?: string[] }
const pr = args?.pr
if (!pr) throw new Error('args.pr (PR number) is required')

const LENSES = args?.lenses ?? [
  'spec-compliance: does the diff do exactly what the referenced issue specifies — nothing missing, nothing extra',
  'correctness: construct concrete inputs that make the new code produce wrong output, corrupt data, or throw',
  'data-safety: truncation, silent drops, destructive migrations, hot-path performance, and repo No-Truncation-Policy violations',
]

const FINDINGS = {
  type: 'object',
  required: ['findings', 'checksPassed'],
  properties: {
    checksPassed: { type: 'boolean', description: 'install + type-check + full test suite passed when run by YOU' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'severity', 'evidence'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { enum: ['blocker', 'major', 'minor', 'nit'] },
          evidence: { type: 'string', description: 'concrete failing input / file:line reasoning' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

phase('Review')
const reviews = await pipeline(
  LENSES,
  (lens, _item, i) =>
    agent(
      `You are reviewer #${i} for PR #${pr} in this repo. Lens: ${lens}. ` +
        `Read the PR (gh pr view ${pr}; gh pr diff ${pr}) and its referenced issue with comments. ` +
        `Check out the PR head SHA detached in a scratch dir via git worktree, run pnpm install, pnpm run type-check, and the full test suite yourself. ` +
        `Then hunt for problems ONLY through your lens. Report findings with concrete evidence; no speculation.`,
      { label: `review:${lens.split(':')[0]}`, phase: 'Review', schema: FINDINGS },
    ),
  (review, lens) =>
    review
      ? parallel(
          review.findings
            .filter(f => f.severity === 'blocker' || f.severity === 'major')
            .map(f => () =>
              agent(
                `Adversarially REFUTE this review finding on PR #${pr} — default to refuted=true unless the evidence stands up to your own independent check of the actual diff (gh pr diff ${pr}) and code: ` +
                  JSON.stringify(f),
                { label: `refute:${f.file}`, phase: 'Refute', schema: VERDICT },
              ).then(v => ({ ...f, refuted: v?.refuted ?? false, refuteReason: v?.reason })),
            ),
        ).then(judged => ({
          lens,
          checksPassed: review.checksPassed,
          confirmed: judged.filter(Boolean).filter(f => !f.refuted),
          minor: review.findings.filter(f => f.severity === 'minor' || f.severity === 'nit'),
        }))
      : null,
)

phase('Verdict')
const rounds = reviews.filter(Boolean)
const confirmed = rounds.flatMap(r => r.confirmed)
const minor = rounds.flatMap(r => r.minor)
const allChecksPassed = rounds.length > 0 && rounds.every(r => r.checksPassed)
log(`${confirmed.length} confirmed blocker/major finding(s), ${minor.length} minor, checksPassed=${allChecksPassed}`)

return {
  pr,
  verdict: allChecksPassed && confirmed.length === 0 ? 'APPROVE' : 'REQUEST_CHANGES',
  checksPassed: allChecksPassed,
  confirmedFindings: confirmed,
  minorFindings: minor,
}
