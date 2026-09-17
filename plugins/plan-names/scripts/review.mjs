#!/usr/bin/env node

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:https';

const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.plannames');
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
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${err.message}`);
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
  if (!existsSync(idFile)) {
    const id = randomUUID();
    ensureDataDir();
    writeFileSync(idFile, id, 'utf8');
    return id;
  }
  const id = readFileSync(idFile, 'utf8').trim();
  if (!id) {
    throw new Error('Invalid install-id file (empty)');
  }
  return id;
}

async function submitIngest(name, tokens, installId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      name,
      agent: 'claude-code',
      agentVersion: null,
      installId,
      clientVersion: '1.0.0'
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
        } catch (err) {
          reject(new Error(`Invalid response from server: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
    req.setTimeout(NETWORK_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function handleList() {
  const pendingFile = join(dataDir, 'pending.json');
  const pending = readJSON(pendingFile) || [];
  console.log(JSON.stringify(pending, null, 2));
}

async function handleSubmit(name) {
  const pendingFile = join(dataDir, 'pending.json');
  const pending = readJSON(pendingFile) || [];

  const entry = pending.find(p => p.name === name);
  if (!entry) {
    throw new Error(`Name not found in pending: ${name}`);
  }

  const installId = getOrCreateInstallId();

  try {
    const response = await submitIngest(name, entry.tokens, installId);
    console.log(`Submitted: ${name} (status: ${response?.status || 'ok'})`);
  } catch (err) {
    throw new Error(`Failed to submit ${name}: ${err.message}`);
  }

  // Remove from pending
  const filtered = pending.filter(p => p.name !== name);
  writeJSONAtomic(pendingFile, filtered);

  // Mark as seen
  const seenFile = join(dataDir, 'seen.json');
  const seen = readJSON(seenFile) || {};
  seen[name] = { submittedAt: Date.now() };
  writeJSONAtomic(seenFile, seen);
}

async function handleDiscard(name) {
  const pendingFile = join(dataDir, 'pending.json');
  const pending = readJSON(pendingFile) || [];

  const entry = pending.find(p => p.name === name);
  if (!entry) {
    throw new Error(`Name not found in pending: ${name}`);
  }

  const filtered = pending.filter(p => p.name !== name);
  writeJSONAtomic(pendingFile, filtered);

  // Mark as seen to avoid re-holding
  const seenFile = join(dataDir, 'seen.json');
  const seen = readJSON(seenFile) || {};
  seen[name] = { discardedAt: Date.now() };
  writeJSONAtomic(seenFile, seen);

  console.log(`Discarded: ${name}`);
}

async function handleDiscardAll() {
  const pendingFile = join(dataDir, 'pending.json');
  const pending = readJSON(pendingFile) || [];

  if (pending.length === 0) {
    console.log('No pending names to discard');
    return;
  }

  // Mark all as seen to avoid re-holding
  const seenFile = join(dataDir, 'seen.json');
  const seen = readJSON(seenFile) || {};
  for (const entry of pending) {
    seen[entry.name] = { discardedAt: Date.now() };
  }
  writeJSONAtomic(seenFile, seen);

  writeJSONAtomic(pendingFile, []);
  console.log(`Discarded all ${pending.length} pending names`);
}

async function main() {
  try {
    const args = process.argv.slice(2);

    if (args.length === 0 || (args[0] !== '--list' && args[0] !== '--submit' && args[0] !== '--discard' && args[0] !== '--discard-all')) {
      throw new Error('Usage: review.mjs --list | --submit <name> | --discard <name> | --discard-all');
    }

    const command = args[0];

    if (command === '--list') {
      await handleList();
    } else if (command === '--submit') {
      if (!args[1]) throw new Error('--submit requires a name argument');
      await handleSubmit(args[1]);
    } else if (command === '--discard') {
      if (!args[1]) throw new Error('--discard requires a name argument');
      await handleDiscard(args[1]);
    } else if (command === '--discard-all') {
      await handleDiscardAll();
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
