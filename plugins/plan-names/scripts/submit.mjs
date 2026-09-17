#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, dirname } from 'node:path';
import { request } from 'node:https';

const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.plannames');
const plansDir = join(homedir(), '.claude', 'plans');
const VOCAB_CACHE_MS = 24 * 60 * 60 * 1000;
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
  return new Promise((resolve) => {
    const options = {
      hostname: 'plannames.dev',
      path: '/v1/vocab',
      method: 'GET',
    };

    const req = request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(NETWORK_TIMEOUT, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
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
  return new Promise((resolve) => {
    const body = JSON.stringify({
      name,
      agent: 'claude-code',
      agentVersion: agentVersion || null,
      installId,
      clientVersion: clientVersion || '1.0.0'
    });

    const options = {
      hostname: 'plannames.dev',
      path: '/v1/ingest',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(NETWORK_TIMEOUT, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
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

    // Check dedup
    const seenFile = join(dataDir, 'seen.json');
    const seen = readJSON(seenFile) || {};
    if (seen[name]) {
      process.exit(0);
    }

    // Get vocab
    const vocab = await getVocab();

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

  } catch (err) {
    // Swallow all errors - hook must never disrupt session
  }

  process.exit(0);
}

main();
