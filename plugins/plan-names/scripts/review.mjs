#!/usr/bin/env node

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDataDir } from './data-dir.mjs';

const dataDir = resolveDataDir();
const baseUrl = (process.env.PLANNAMES_BASE_URL || 'https://plannames.dev').replace(/\/$/, '');
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
  const body = JSON.stringify({
    name,
    agent: 'claude-code',
    agentVersion: null,
    installId,
    clientVersion: '1.0.0'
  });

  let res;
  try {
    res = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body,
      signal: AbortSignal.timeout(NETWORK_TIMEOUT)
    });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  try {
    return await res.json();
  } catch (err) {
    throw new Error(`Invalid response from server: ${err.message}`);
  }
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

// Asks the server for a short code and prints it. Deliberately the whole of the client's part
// in email capture: the address is typed on the website, on a page that states what is kept
// and why. The plugin sends the same installId it already sends with every name, so nothing
// leaves this machine that was not leaving it already.
async function handleClaim() {
  const installId = getOrCreateInstallId();

  let res;
  try {
    res = await fetch(`${baseUrl}/v1/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId }),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT)
    });
  } catch (err) {
    throw new Error(`Could not reach plannames.dev: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`plannames.dev returned ${res.status}`);
  }

  const data = await res.json();
  const minutes = Math.max(1, Math.round((data.expiresAt - Date.now()) / 60000));

  console.log('');
  console.log(`  Your claim code:  ${data.code}`);
  console.log('');
  console.log(`  Enter it at ${data.claimUrl || `${baseUrl}/claim`} with your email.`);
  console.log(`  It expires in ${minutes} minutes and can be used once.`);
  console.log('');
  console.log('  You will get one email when a name from this install reaches the top ten.');
  console.log('  Nothing else, and one click to leave.');
  console.log('');
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const COMMANDS = ['--list', '--submit', '--discard', '--discard-all', '--claim'];

    if (args.length === 0 || !COMMANDS.includes(args[0])) {
      throw new Error('Usage: review.mjs --list | --submit <name> | --discard <name> | --discard-all | --claim');
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
    } else if (command === '--claim') {
      await handleClaim();
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    // Set the code rather than forcing exit: --submit fails after a request, and tearing down
    // mid-teardown trips the same libuv assertion that used to crash the hook.
    process.exitCode = 1;
  }
}

main();
