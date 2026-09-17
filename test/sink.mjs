// Logging sink: stands in for plannames.dev. Records every request to requests.json.
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const LOG = join(fileURLToPath(new URL('.', import.meta.url)), 'requests.json');
const VOCAB = ['jaunty', 'soaring', 'adleman', 'flickering', 'jellyfish', 'quiet', 'amber', 'otter'];

function log(entry) {
  const cur = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : [];
  cur.push(entry);
  writeFileSync(LOG, JSON.stringify(cur, null, 2));
}

createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    log({ method: req.method, url: req.url, body: body || null, at: Date.now() });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/vocab') {
      // Tests drop a token in this file to simulate the generator's wordlist gaining a word.
      const extraFile = join(fileURLToPath(new URL('.', import.meta.url)), 'vocab-extra');
      const extra = existsSync(extraFile) ? readFileSync(extraFile, 'utf8').split(/\s+/).filter(Boolean) : [];
      res.end(JSON.stringify({ version: 'testvocab', updatedAt: '2026-09-17', tokens: [...VOCAB, ...extra] }));
    } else if (req.url === '/v1/ingest') {
      res.end(JSON.stringify({ status: 'published', notice: null }));
    } else if (req.url === '/v1/health') {
      // Tests toggle this file to simulate the endpoint not being deployed yet.
      if (existsSync(join(fileURLToPath(new URL('.', import.meta.url)), 'health-fail'))) {
        res.statusCode = 404; res.end('{}'); return;
      }
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
}).listen(4599, () => console.log('sink on 4599'));
