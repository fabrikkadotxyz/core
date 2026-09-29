/**
 * Turning an agent's tool call into something safe to show a shared room.
 *
 * This runs on the RUNNER, before the event reaches the wire — the only place
 * where redaction stops a secret travelling at all. Doing it on the server or in
 * the browser would mean the value had already left the user's machine.
 *
 * The governing rule from ADR 0015: a summary, never a transcript. Tool output is
 * never carried, and neither are full command lines. Agent activity is the
 * owner's private work and the session is shared, so `Bash(curl -H "Authorization:
 * Bearer sk-…")` must not become a line everyone can read.
 */

/** Longest descriptor we will emit. Long values are where secrets hide. */
const MAX_DETAIL = 80;

/**
 * Credential shapes worth catching. Not exhaustive and cannot be: a secret with
 * no recognisable prefix, or one spanning whitespace, will not match — the same
 * limitation Claude Code documents for its own masking. The real defence is that
 * output is never streamed and arguments are reduced to one short descriptor, so
 * the exposure is a fragment rather than a transcript.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / Stripe style
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub personal access token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b(?:Bearer|Basic|token|api[_-]?key|password|secret)\s*[:=]?\s*\S{8,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex: hashes, but also plenty of tokens
];

/** Replace anything credential-shaped. Applied before truncation, not after. */
export function redact(value: string): string {
  let out = value;
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

function shorten(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_DETAIL) return flat;
  return flat.slice(0, MAX_DETAIL - 1) + '…';
}

export interface ToolCall {
  name: string;
  /** Raw arguments, as the agent sent them. Never emitted as-is. */
  args?: unknown;
}

export interface ActivityLine {
  tool: string;
  detail: string | null;
}

/**
 * Reduce a tool call to a tool name and at most one short descriptor.
 *
 * Deliberately per-tool rather than generic: the useful descriptor for `Read` is a
 * path, and for `Bash` it is the program being run. A generic
 * "stringify the arguments" would be exactly the transcript ADR 0015 rules out.
 */
export function summarise(call: ToolCall): ActivityLine {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof args[key] === 'string' ? (args[key] as string) : null;

  switch (call.name) {
    // File tools: the path is the whole point, and is usually safe. Redact anyway
    // — a path can contain a token in a URL-ish argument.
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = str('file_path') ?? str('path') ?? str('notebook_path');
      return { tool: call.name, detail: path ? shorten(redact(path)) : null };
    }

    case 'Glob':
    case 'Grep': {
      const pattern = str('pattern');
      return { tool: call.name, detail: pattern ? shorten(redact(pattern)) : null };
    }

    /**
     * Bash gets ONLY the program name. A command line is the single most likely
     * place for a credential to appear, and "it ran curl" is nearly all of the
     * informational value of "it ran curl with these nineteen flags".
     */
    case 'Bash':
    case 'BashOutput': {
      const command = str('command');
      if (!command) return { tool: 'Bash', detail: null };
      const program = command.trim().split(/[\s;|&]/)[0] ?? '';
      return { tool: 'Bash', detail: program ? shorten(redact(program)) : null };
    }

    case 'WebFetch': {
      // Host only: a URL's path and query routinely carry tokens.
      const url = str('url');
      if (!url) return { tool: call.name, detail: null };
      try {
        return { tool: call.name, detail: new URL(url).host };
      } catch {
        return { tool: call.name, detail: null };
      }
    }

    case 'WebSearch': {
      const query = str('query');
      return { tool: call.name, detail: query ? shorten(redact(query)) : null };
    }

    case 'Task':
    case 'TodoWrite':
      return { tool: call.name, detail: null };

    default:
      // Unknown tools — including every aggregated integration tool — get their
      // name and nothing else. Guessing which argument is safe for a tool we have
      // never seen is exactly how a secret leaks.
      return { tool: call.name, detail: null };
  }
}
