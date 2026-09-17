#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, dirname } from 'node:path';
import { resolveDataDir } from './data-dir.mjs';

const dataDir = resolveDataDir();
const baseUrl = (process.env.PLANNAMES_BASE_URL || 'https://plannames.dev').replace(/\/$/, '');
const plansDir = join(homedir(), '.claude', 'plans');
const VOCAB_CACHE_MS = 24 * 60 * 60 * 1000;
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A backlog is cleared a few per run rather than all at once: this runs inside a hook, and each
// submission is a request with its own timeout.
const RECONCILE_BATCH = 10;
const NETWORK_TIMEOUT = 3000;

function ensureDataDir() {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

function readJSON(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSONAtomic(file, data) {
  ensureDataDir();
  const tmpFile = file + '.tmp';
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpFile, file);
}

function getOrCreateInstallId() {
  const idFile = join(dataDir, 'install-id');
  let id;
  if (existsSync(idFile)) {
    id = readFileSync(idFile, 'utf8').trim();
  }
  if (!id) {
    id = randomUUID();
    ensureDataDir();
    writeFileSync(idFile, id, 'utf8');
  }
  return id;
}

function tokenize(name) {
  return name.toLowerCase().replace(/\.md$/, '').split('-').filter(t => t.length > 0);
}

function classify(tokens, vocabData) {
  const known = [];
  const unknown = [];
  const vocabSet = new Set((vocabData?.tokens || []).map(t => t.toLowerCase()));

  for (const token of tokens) {
    if (vocabSet.has(token.toLowerCase())) {
      known.push(token);
    } else {
      unknown.push(token);
    }
  }

  return { known, unknown };
}

async function fetchVocab() {
  try {
    const res = await fetch(`${baseUrl}/v1/vocab`, {
      headers: { 'Connection': 'close' },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function getVocab() {
  ensureDataDir();
  const vocabFile = join(dataDir, 'vocab.json');
  const cached = readJSON(vocabFile);

  if (cached && cached.timestamp && Date.now() - cached.timestamp < VOCAB_CACHE_MS) {
    return Promise.resolve(cached);
  }

  return fetchVocab().then(fresh => {
    if (fresh) {
      const withTimestamp = { ...fresh, timestamp: Date.now() };
      writeJSONAtomic(vocabFile, withTimestamp);
      return withTimestamp;
    }
    return cached || null;
  });
}

async function submitIngest(name, tokens, agentVersion, clientVersion, installId) {
  const body = JSON.stringify({
    name,
    agent: 'claude-code',
    agentVersion: agentVersion || null,
    installId,
    clientVersion: clientVersion || '1.0.0'
  });

  try {
    const res = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body,
      signal: AbortSignal.timeout(NETWORK_TIMEOUT)
    });
    return await res.json();
  } catch {
    return null;
  }
}

function bumpCounter(field) {
  const statsFile = join(dataDir, 'stats.json');
  const stats = readJSON(statsFile) || { submitted: 0, held: 0, periodStart: Date.now(), lastReportAt: Date.now() };
  stats[field] = (stats[field] || 0) + 1;
  writeJSONAtomic(statsFile, stats);
}

// Counts only, once a day. This is the one signal that the generator's wordlist has moved
// ahead of the server's: names themselves stay on this machine, so a rising held rate is all
// there is to go on. Never carries a name or a token.
async function maybeReport(clientVersion) {
  const statsFile = join(dataDir, 'stats.json');
  const stats = readJSON(statsFile);
  if (!stats) return;
  if (stats.submitted + stats.held === 0) return;
  if (!stats.lastReportAt) {
    // Older stats file with no clock set: start it now rather than treating it as overdue.
    writeJSONAtomic(statsFile, { ...stats, lastReportAt: Date.now() });
    return;
  }
  if (Date.now() - stats.lastReportAt < REPORT_INTERVAL_MS) return;

  const body = JSON.stringify({
    installId: getOrCreateInstallId(),
    clientVersion: clientVersion || '1.0.0',
    submitted: stats.submitted,
    held: stats.held,
    periodStart: stats.periodStart || Date.now()
  });

  let ok = false;
  try {
    const res = await fetch(`${baseUrl}/v1/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body,
      signal: AbortSignal.timeout(NETWORK_TIMEOUT)
    });
    ok = res.ok;
  } catch {
    ok = false;
  }

  // Only clear the counters once the server has them. The client ships before the endpoint
  // exists, so early reports 404 and those counts must survive to the next attempt.
  if (ok) {
    writeJSONAtomic(statsFile, { submitted: 0, held: 0, periodStart: Date.now(), lastReportAt: Date.now() });
  }
}

// A name held under an older wordlist is not prompt text once every one of its tokens turns out
// to be generator vocabulary — the reason it was held is gone, so it goes. Anything still
// carrying an unknown token stays put and waits for an explicit yes via /plannames.
async function reconcilePending(vocab, clientVersion) {
  if (!vocab) return;

  const pendingFile = join(dataDir, 'pending.json');
  const pending = readJSON(pendingFile);
  if (!pending || pending.length === 0) return;

  const stillHeld = [];
  const cleared = [];

  for (const entry of pending) {
    const { unknown } = classify(entry.tokens || tokenize(entry.name), vocab);
    if (unknown.length > 0 || cleared.length >= RECONCILE_BATCH) {
      stillHeld.push(entry);
    } else {
      cleared.push(entry);
    }
  }

  if (cleared.length === 0) return;

  const seenFile = join(dataDir, 'seen.json');
  const seen = readJSON(seenFile) || {};
  const installId = getOrCreateInstallId();

  for (const entry of cleared) {
    await submitIngest(entry.name, entry.tokens, null, clientVersion, installId);
    seen[entry.name] = { submittedAt: Date.now() };
    bumpCounter('submitted');
  }

  writeJSONAtomic(seenFile, seen);
  writeJSONAtomic(pendingFile, stillHeld);

  console.log(JSON.stringify({
    systemMessage: `plan-names: ${cleared.length} previously held name${cleared.length === 1 ? '' : 's'} turned out to be generator vocabulary and ${cleared.length === 1 ? 'was' : 'were'} submitted.`
  }));
}

function handleNotice(notice) {
  if (!notice) return;
  const noticeFile = join(dataDir, 'notice-shown');
  const lastShown = parseInt(readFileSync(noticeFile, 'utf8').trim() || '0', 10);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  if (now - lastShown > dayMs) {
    console.log(JSON.stringify({
      systemMessage: `plan-names: ${notice}`
    }));
    writeFileSync(noticeFile, now.toString(), 'utf8');
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  try {
    ensureDataDir();

    // Read stdin
    const input = await readStdin();

    let payload;
    try {
      payload = JSON.parse(input);
    } catch {
      process.exit(0);
    }

    const filePath = payload?.tool_input?.file_path;
    if (!filePath) process.exit(0);

    // Normalize path and validate it's in plans dir
    const normalized = resolve(filePath);
    const plansResolved = resolve(plansDir);

    // File must be directly in plans dir (not subdirectories) and end with .md
    if (dirname(normalized) !== plansResolved || !normalized.endsWith('.md')) {
      process.exit(0);
    }

    // Extract name from basename
    const name = basename(normalized, '.md').toLowerCase();

    // Validate name format and length
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 120) {
      process.exit(0);
    }

    // Report before the dedup exit below: a starved vocabulary shows up as names that stop
    // being new, which is exactly when a report placed at the end would never be sent.
    await maybeReport(payload?.tool_input?.clientVersion);

    // Refresh the vocabulary and reconsider anything held under an older wordlist. Both sit
    // above the dedup exit: a stale list must still refresh on runs that produce no new name,
    // which is exactly the case when the wordlist has drifted and everything is being held.
    const vocab = await getVocab();
    await reconcilePending(vocab, payload?.tool_input?.clientVersion);

    // Check dedup
    const seenFile = join(dataDir, 'seen.json');
    const seen = readJSON(seenFile) || {};
    if (seen[name]) {
      process.exit(0);
    }

    // Fail closed: if no vocab, treat all tokens as unknown
    const tokens = tokenize(name);
    const { unknown } = classify(tokens, vocab);

    if (unknown.length > 0) {
      // Hold the name
      const pendingFile = join(dataDir, 'pending.json');
      const pending = readJSON(pendingFile) || [];
      pending.push({
        name,
        tokens,
        unknown,
        firstSeenAt: Date.now()
      });
      writeJSONAtomic(pendingFile, pending);

      // Mark as seen to avoid duplicate holds
      seen[name] = { heldAt: Date.now() };
      writeJSONAtomic(seenFile, seen);
      bumpCounter('held');

      // Emit notice
      console.log(JSON.stringify({
        systemMessage: `plan-names: 1 name held back because it may contain your prompt text. Run /plannames to review.`
      }));

      process.exit(0);
    }

    // All tokens known, submit
    const installId = getOrCreateInstallId();
    const agentVersion = payload?.tool_input?.agentVersion || null;
    const clientVersion = payload?.tool_input?.clientVersion || null;

    await submitIngest(name, tokens, agentVersion, clientVersion, installId);

    // Record as seen
    seen[name] = { submittedAt: Date.now() };
    writeJSONAtomic(seenFile, seen);
    bumpCounter('submitted');

  } catch (err) {
    // Swallow all errors - hook must never disrupt session
  }

  // Exit naturally rather than calling process.exit(): on Windows, tearing the process down while
  // a request's socket is still closing trips a libuv assertion, and a hook that exits non-zero
  // puts its stderr in front of the user. Sockets are not pooled, so this returns immediately.
  process.exitCode = 0;
}

main();
