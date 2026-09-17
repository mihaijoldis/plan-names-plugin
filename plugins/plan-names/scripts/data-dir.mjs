import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Claude Code sets CLAUDE_PLUGIN_DATA when it runs a hook, but a slash command only
// receives it if the command file passes it through. The hook and `/plannames` must
// agree on one directory, or held names are written where the review command cannot
// see them, so derive the same path when the variable is missing.
export function resolveDataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return process.env.CLAUDE_PLUGIN_DATA;
  }

  // Installed layout: <claude>/plugins/cache/<marketplace>/<plugin>/<version>/scripts/
  // Data lives at:    <claude>/plugins/data/<plugin>-<marketplace>/
  const parts = dirname(fileURLToPath(import.meta.url)).split(sep);
  const cacheIdx = parts.lastIndexOf('cache');

  if (cacheIdx > 0 && parts.length > cacheIdx + 2) {
    const marketplace = parts[cacheIdx + 1];
    const plugin = parts[cacheIdx + 2];
    return join(parts.slice(0, cacheIdx).join(sep), 'data', `${plugin}-${marketplace}`);
  }

  // Running from a checkout rather than an install.
  return join(homedir(), '.plannames');
}
