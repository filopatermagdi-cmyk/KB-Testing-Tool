// Signal 2: run the Python interruption classifier on the call just placed.
// Captures its output (echoed to the terminal), parses the INTERRUPTION_RESULT
// line, and RETURNS the verdict string so main() can persist it in the summary.
// Non-blocking: the verdict does not affect e2e's exit code. If the classifier
// can't run/analyze, it returns an ERROR string (inconclusive) — NOT FAIL, which
// is reserved for an actual detected talk-over.
import path from 'path';
import { spawnSync } from 'node:child_process';
import { ROOT, OUT_DIR, INTERRUPTION_WAIT_S, CFG, log } from './config';
import type { AttemptResult } from './types';

// The classifier couldn't produce a verdict (missing deps, no output). That's an
// inconclusive ERROR, not an interruption FAIL — consumers treat it like SKIPPED.
function classifierError(reason: string): string {
  const verdict = `ERROR (${reason})`;
  console.log(`INTERRUPTION_RESULT=${verdict}`);
  return verdict;
}

export function runInterruptionCheck(result: AttemptResult): string {
  const script = path.join(ROOT, 'classify_interruptions.py'); // self-contained: local copy
  const python = process.env.PYTHON || 'python';
  log('running interruption check (separate signal)...');
  const args = [
    script,
    '--handoff',
    path.join(OUT_DIR, 'last-call.json'),
    '--no-web-filter',
    '--wait-recording-seconds',
    String(INTERRUPTION_WAIT_S),
    '-d',
    path.join(OUT_DIR, 'recordings'),
  ];
  if (result?.conversationId) {
    args.push('--call-id', result.conversationId);
  } else {
    args.push('--latest');
  }
  const proc = spawnSync(python, args, {
    stdio: ['inherit', 'pipe', 'inherit'], // capture stdout (verdict); stderr streams live
    encoding: 'utf8',
    // Same account as the E2E login; the classifier reads these env names.
    env: { ...process.env, ZIILA_API_EMAIL: CFG.email, ZIILA_API_PASSWORD: CFG.password },
  });
  const out = proc.stdout || '';
  if (out) process.stdout.write(out); // classifier prints the call url + verdict — keep showing it
  if (proc.error) {
    log(
      `interruption check could not run: ${proc.error.message} ` +
        `(need Python + numpy; set PYTHON=python3 in CI, or run 'npm run interruption')`,
    );
    return classifierError('classifier could not run');
  }
  const m = out.match(/INTERRUPTION_RESULT=(.+)/);
  if (m) return m[1].trim();

  const exit = proc.signal ? `signal ${proc.signal}` : `exit ${proc.status ?? 'unknown'}`;
  log(`interruption check finished without an INTERRUPTION_RESULT line (${exit})`);
  return classifierError(`classifier produced no verdict: ${exit}`);
}
