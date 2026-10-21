/**
 * A small S3-compatible client (M66, ADR 0060): put, get, head and list, on
 * any endpoint that speaks the S3 API (AWS, R2, B2, MinIO, …). It signs its
 * own requests with AWS Signature Version 4 on node:crypto rather than pull in
 * the AWS SDK for four calls. `signV4` is exported for the unit test, which
 * checks it against AWS's published example.
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  /** An endpoint URL, e.g. https://<account>.r2.cloudflarestorage.com. Empty means AWS for the region. */
  endpoint: string | null;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prepended to every key, e.g. "fabrikka/". */
  prefix: string;
  /** `https://host/bucket/key` instead of `https://bucket.host/key`. */
  pathStyle: boolean;
}

export class S3Error extends Error {
  constructor(message: string, readonly status: number | null = null, readonly code: string | null = null) {
    super(message);
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986: everything but unreserved characters is percent-encoded. */
export function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A path, each segment encoded, the slashes kept. */
const encodePath = (p: string) => p.split('/').map(encodeRfc3986).join('/');

export interface SignInput {
  method: string;
  host: string;
  /** Already-encoded path, starting with "/". */
  path: string;
  query?: Record<string, string>;
  /** Extra headers to sign, lower-case names. host, x-amz-date and x-amz-content-sha256 are added. */
  headers?: Record<string, string>;
  payloadHash: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
}

/** Signature Version 4. Returns every header the request must carry, Authorization included. */
export function signV4(i: SignInput): Record<string, string> {
  const service = i.service ?? 's3';
  const date = i.amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: i.host,
    'x-amz-content-sha256': i.payloadHash,
    'x-amz-date': i.amzDate,
  };
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.entries(i.query ?? {})
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [i.method, i.path, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${i.secretAccessKey}`, date);
  const kRegion = hmac(kDate, i.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const amzNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The pieces of an S3 error body worth repeating: <Code> and <Message>. */
function errorFrom(status: number, body: string): S3Error {
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1] ?? null;
  const msg = /<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? null;
  return new S3Error(`${status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`, status, code);
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function createS3Client(cfg: S3Config, doFetch: typeof fetch = fetch) {
  const base = new URL(cfg.endpoint || `https://s3.${cfg.region}.amazonaws.com`);
  const basePath = base.pathname.replace(/\/+$/, '');
  const host = cfg.pathStyle ? base.host : `${cfg.bucket}.${base.host}`;
  const bucketPath = cfg.pathStyle ? `${basePath}/${encodeRfc3986(cfg.bucket)}` : basePath;

  async function send(method: string, key: string | null, opts: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {}) {
    const path = key === null ? `${bucketPath}/` : `${bucketPath}/${encodePath(cfg.prefix + key)}`;
    const signed = signV4({
      method,
      host,
      path,
      query: opts.query,
      headers: opts.headers,
      payloadHash: opts.body ? sha256(opts.body) : EMPTY_SHA256,
      amzDate: amzNow(),
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
    const { host: _host, ...sendHeaders } = signed;
    const qs = new URLSearchParams(opts.query ?? {}).toString().replace(/\+/g, '%20');
    const url = `${base.protocol}//${host}${path}${qs ? `?${qs}` : ''}`;
    try {
      return await doFetch(url, { method, headers: sendHeaders, body: opts.body ? new Uint8Array(opts.body) : undefined });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new S3Error(`could not reach ${base.host}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
    }
  }

  return {
    describe: () => `s3 bucket "${cfg.bucket}" at ${base.host}${cfg.prefix ? `, prefix "${cfg.prefix}"` : ''}`,

    async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
      const r = await send('PUT', key, { body, headers: { 'content-type': contentType } });
      if (!r.ok) throw errorFrom(r.status, await r.text());
      await r.arrayBuffer().catch(() => undefined);
    },

    async get(key: string): Promise<Buffer | null> {
      const r = await send('GET', key);
      if (r.status === 404) {
        await r.arrayBuffer().catch(() => undefined);
        return null;
      }
      if (!r.ok) throw errorFrom(r.status, await r.text());
      return Buffer.from(await r.arrayBuffer());
    },

    async head(key: string): Promise<boolean> {
      const r = await send('HEAD', key);
      await r.arrayBuffer().catch(() => undefined);
      if (r.status === 404) return false;
      if (!r.ok) throw new S3Error(`${r.status} on HEAD`, r.status);
      return true;
    },

    /** Gone, or never there: S3 answers 204 either way. */
    async remove(key: string): Promise<void> {
      const r = await send('DELETE', key);
      const body = await r.text();
      if (!r.ok && r.status !== 404) throw errorFrom(r.status, body);
    },

    /** Every key under the prefix, the prefix stripped. */
    async *list(): AsyncGenerator<string> {
      let token: string | undefined;
      do {
        const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
        if (cfg.prefix) query.prefix = cfg.prefix;
        if (token) query['continuation-token'] = token;
        const r = await send('GET', null, { query });
        const body = await r.text();
        if (!r.ok) throw errorFrom(r.status, body);
        for (const m of body.matchAll(/<Key>([^<]*)<\/Key>/g)) yield unescapeXml(m[1]!).slice(cfg.prefix.length);
        token = /<IsTruncated>true<\/IsTruncated>/.test(body)
          ? unescapeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1] ?? '') || undefined
          : undefined;
      } while (token);
    },
  };
}

export type S3Client = ReturnType<typeof createS3Client>;
