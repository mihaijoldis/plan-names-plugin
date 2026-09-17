// Branch tests for submit.mjs. Each case gets a virgin data dir + a fresh sink log.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, '..', 'plugins', 'plan-names', 'scripts', 'submit.mjs');
const LOG = join(HERE, 'requests.json');
const PLANS = join(homedir(), '.claude', 'plans');

function run({ filePath, base = 'http://127.0.0.1:4599', dataDir, stdin, extraEnv }) {
  writeFileSync(LOG, '[]');
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'pn-'));
  const input = stdin !== undefined ? stdin : JSON.stringify({ tool_input: { file_path: filePath } });
  const out = execFileSync(process.execPath, [SCRIPT], {
    input,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, PLANNAMES_BASE_URL: base, ...extraEnv },
    encoding: 'utf8'
  });
  const reqs = JSON.parse(readFileSync(LOG, 'utf8'));
  const read = f => existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null;
  return { out: out.trim(), reqs, dir, pending: read('pending.json'), seen: read('seen.json'), stats: read('stats.json') };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); }
}

console.log('\n1. all-known name -> vocab fetch + ingest POST');
{
  const r = run({ filePath: join(PLANS, 'jaunty-soaring-adleman.md') });
  const ingest = r.reqs.find(q => q.url === '/v1/ingest');
  check('fetched vocab', r.reqs.some(q => q.url === '/v1/vocab'), JSON.stringify(r.reqs));
  check('posted ingest', !!ingest, JSON.stringify(r.reqs));
  check('body is filename only', ingest && Object.keys(JSON.parse(ingest.body)).sort().join(',') ===
    'agent,agentVersion,clientVersion,installId,name', ingest?.body);
  check('name correct', ingest && JSON.parse(ingest.body).name === 'jaunty-soaring-adleman', ingest?.body);
  check('no path leaked', !JSON.stringify(r.reqs).includes('.claude'), 'path found in payload');
  check('marked submitted', r.seen?.['jaunty-soaring-adleman']?.submittedAt > 0, JSON.stringify(r.seen));
}

console.log('\n2. unknown token -> held, NO ingest');
{
  const r = run({ filePath: join(PLANS, 'i-want-you-to-flickering-jellyfish.md') });
  check('zero ingest requests', !r.reqs.some(q => q.url === '/v1/ingest'), JSON.stringify(r.reqs));
  check('held in pending', r.pending?.[0]?.name === 'i-want-you-to-flickering-jellyfish', JSON.stringify(r.pending));
  check('unknown tokens flagged', JSON.stringify(r.pending?.[0]?.unknown) === '["i","want","you","to"]', JSON.stringify(r.pending?.[0]?.unknown));
  check('systemMessage emitted', r.out.includes('systemMessage') && r.out.includes('/plannames'), r.out);
}

console.log('\n3. already-seen name -> silent no-op');
{
  const first = run({ filePath: join(PLANS, 'quiet-amber-otter.md') });
  const r = run({ filePath: join(PLANS, 'quiet-amber-otter.md'), dataDir: first.dir });
  check('first run submitted', first.reqs.some(q => q.url === '/v1/ingest'), JSON.stringify(first.reqs));
  check('second run: zero requests', r.reqs.length === 0, JSON.stringify(r.reqs));
  check('no output', r.out === '', r.out);
}

console.log('\n4. PRIVACY: file in a plans SUBdirectory -> no-op');
{
  const r = run({ filePath: join(PLANS, 'archive', 'jaunty-soaring-adleman.md') });
  check('zero requests', r.reqs.length === 0, JSON.stringify(r.reqs));
  check('nothing held', r.pending === null, JSON.stringify(r.pending));
}

console.log('\n5. PRIVACY: file outside plans dir -> no-op');
{
  const r = run({ filePath: 'E:/Dev Projects/plan-names/SECRET-NOTES.md' });
  check('zero requests', r.reqs.length === 0, JSON.stringify(r.reqs));
  check('nothing held', r.pending === null, JSON.stringify(r.pending));
}

console.log('\n6. bad name format (spaces/underscores/caps) -> no-op');
{
  for (const n of ['My Plan Draft.md', 'some_plan_name.md', '--leading.md']) {
    const r = run({ filePath: join(PLANS, n) });
    check(`rejected "${n}"`, r.reqs.length === 0 && r.pending === null, JSON.stringify(r.reqs));
  }
}

console.log('\n7. FAIL CLOSED: server unreachable, no vocab cache -> held, not sent');
{
  const r = run({ filePath: join(PLANS, 'jaunty-soaring-adleman.md'), base: 'http://127.0.0.1:4988' });
  check('nothing sent to sink', r.reqs.length === 0, JSON.stringify(r.reqs));
  check('name held instead', r.pending?.[0]?.name === 'jaunty-soaring-adleman', JSON.stringify(r.pending));
  check('all tokens marked unknown', r.pending?.[0]?.unknown?.length === 3, JSON.stringify(r.pending?.[0]));
}

console.log('\n8. malformed / empty stdin -> exit 0, no-op');
{
  for (const s of ['not json at all', '', '{}', '{"tool_input":{}}']) {
    const r = run({ filePath: null, stdin: s });
    check(`survived stdin ${JSON.stringify(s.slice(0, 20))}`, r.reqs.length === 0, JSON.stringify(r.reqs));
  }
}

console.log('\n9. non-.md file in plans dir -> no-op');
{
  const r = run({ filePath: join(PLANS, 'jaunty-soaring-adleman.txt') });
  check('zero requests', r.reqs.length === 0, JSON.stringify(r.reqs));
}

console.log('');
console.log('10. PRIVACY: health report carries counts only, never a name or token');
{
  const first = run({ filePath: join(PLANS, 'quiet-amber-otter.md') });
  check('no report on first run', !first.reqs.some(q => q.url === '/v1/health'), JSON.stringify(first.reqs.map(q => q.url)));
  check('counters seeded', first.stats?.submitted === 1, JSON.stringify(first.stats));
  check('clock starts at install, not epoch', first.stats?.lastReportAt > 0, JSON.stringify(first.stats));

  writeFileSync(join(first.dir, 'stats.json'), JSON.stringify({ ...first.stats, lastReportAt: Date.now() - 25 * 3600 * 1000 }));
  const r = run({ filePath: join(PLANS, 'jaunty-soaring-adleman.md'), dataDir: first.dir });
  const health = r.reqs.find(q => q.url === '/v1/health');
  check('report sent once due', !!health, JSON.stringify(r.reqs.map(q => q.url)));
  const body = health ? JSON.parse(health.body) : {};
  check('no name field', !('name' in body), health?.body);
  check('no tokens field', !('tokens' in body), health?.body);
  check('counts only', Object.keys(body).sort().join(',') === 'clientVersion,held,installId,periodStart,submitted', health?.body);
  // Reset to zero on the 2xx, then this same run's own submission counts as 1 (not 2).
  check('counters reset after 2xx', r.stats?.submitted === 1 && r.stats?.held === 0, JSON.stringify(r.stats));
  check('report clock advanced', r.stats?.lastReportAt > Date.now() - 60000, JSON.stringify(r.stats));
}

console.log('');
console.log('11. counters survive a failed report (endpoint not deployed yet)');
{
  const first = run({ filePath: join(PLANS, 'quiet-amber-otter.md') });
  writeFileSync(join(first.dir, 'stats.json'), JSON.stringify({ submitted: 7, held: 3, periodStart: 1, lastReportAt: Date.now() - 25 * 3600 * 1000 }));
  const flag = join(HERE, 'health-fail');
  writeFileSync(flag, '');
  let r;
  try {
    r = run({ filePath: join(PLANS, 'jaunty-soaring-adleman.md'), dataDir: first.dir });
  } finally {
    unlinkSync(flag);
  }
  check('report attempted', r.reqs.some(q => q.url === '/v1/health'), JSON.stringify(r.reqs.map(q => q.url)));
  check('counts preserved on non-2xx', r.stats?.submitted === 8 && r.stats?.held === 3, JSON.stringify(r.stats));
}

console.log('');
console.log('12. report fires even when the name is a dedup no-op');
{
  const first = run({ filePath: join(PLANS, 'quiet-amber-otter.md') });
  writeFileSync(join(first.dir, 'stats.json'), JSON.stringify({ ...first.stats, lastReportAt: Date.now() - 25 * 3600 * 1000 }));
  const r = run({ filePath: join(PLANS, 'quiet-amber-otter.md'), dataDir: first.dir });
  check('reported despite dedup exit', r.reqs.some(q => q.url === '/v1/health'), JSON.stringify(r.reqs.map(q => q.url)));
  check('no ingest on dedup', !r.reqs.some(q => q.url === '/v1/ingest'), JSON.stringify(r.reqs.map(q => q.url)));
}

console.log('');
console.log('13. held name is auto-submitted once the vocabulary catches up');
{
  // Held under a wordlist that lacks 'quokka'.
  const first = run({ filePath: join(PLANS, 'quiet-amber-quokka.md') });
  check('held initially', first.pending?.[0]?.name === 'quiet-amber-quokka', JSON.stringify(first.pending));
  check('not submitted', !first.reqs.some(q => q.url === '/v1/ingest'), JSON.stringify(first.reqs.map(q => q.url)));

  // Wordlist gains 'quokka'; expire the cache so the next run refetches.
  writeFileSync(join(HERE, 'vocab-extra'), 'quokka');
  writeFileSync(join(first.dir, 'vocab.json'), JSON.stringify({ tokens: [], timestamp: 0 }));
  let r;
  try {
    r = run({ filePath: join(PLANS, 'jaunty-soaring-adleman.md'), dataDir: first.dir });
  } finally {
    // A crashed run must not leave the fixture behind and silently poison later runs.
    unlinkSync(join(HERE, 'vocab-extra'));
  }

  const submitted = r.reqs.filter(q => q.url === '/v1/ingest').map(q => JSON.parse(q.body).name);
  check('previously held name submitted', submitted.includes('quiet-amber-quokka'), JSON.stringify(submitted));
  check('pending now empty', (r.pending || []).length === 0, JSON.stringify(r.pending));
  check('recorded as submitted', r.seen?.['quiet-amber-quokka']?.submittedAt > 0, JSON.stringify(r.seen));
  check('user is told', r.out.includes('previously held'), r.out);
}

console.log('');
console.log('14. PRIVACY: a still-unknown held name is never auto-submitted');
{
  const first = run({ filePath: join(PLANS, 'please-help-me-vivid-otter.md') });
  check('held initially', first.pending?.[0]?.name === 'please-help-me-vivid-otter', JSON.stringify(first.pending));

  // Vocabulary refreshes, but still has none of the prompt words.
  writeFileSync(join(first.dir, 'vocab.json'), JSON.stringify({ tokens: [], timestamp: 0 }));
  const r = run({ filePath: join(PLANS, 'jaunty-soaring-adleman.md'), dataDir: first.dir });

  const submitted = r.reqs.filter(q => q.url === '/v1/ingest').map(q => JSON.parse(q.body).name);
  check('prompt-text name NOT submitted', !submitted.includes('please-help-me-vivid-otter'), JSON.stringify(submitted));
  check('still held', r.pending?.some(e => e.name === 'please-help-me-vivid-otter'), JSON.stringify(r.pending));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
