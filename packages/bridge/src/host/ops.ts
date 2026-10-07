/**
 * What can be done to a host's folders, once — whether asked by the local page
 * (M31) or by the desktop app over stdio (M34). Both paths go through these, so
 * the refusals can't differ between them (ADR 0027, 0031).
 */
import { POLICIES, type Policy } from '../spawn.ts';
import type { Grant } from './config.ts';
import { checkGrantPath, defaultLabel, newGrantId } from './grants.ts';
import type { Host } from './host.ts';

export type OpResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

const asPolicy = (p: unknown): Policy => (POLICIES.includes(p as Policy) ? (p as Policy) : 'edit');

export function addGrant(host: Host, input: { path?: string; label?: string; policy?: unknown }): OpResult<Grant> {
  const checked = checkGrantPath(input.path ?? '');
  if (!checked.ok) return checked;
  if (host.cfg.grants.some((g) => g.path === checked.path)) return { ok: false, error: 'that folder is already granted' };
  const grant: Grant = {
    id: newGrantId(),
    label: (input.label ?? '').trim().slice(0, 80) || defaultLabel(checked.path),
    path: checked.path,
    policy: asPolicy(input.policy),
  };
  host.cfg.grants.push(grant);
  host.grantsChanged();
  return { ok: true, value: grant };
}

export function updateGrant(host: Host, grantId: string, input: { label?: string; policy?: unknown }): OpResult {
  const grant = host.cfg.grants.find((g) => g.id === grantId);
  if (!grant) return { ok: false, error: 'no such grant' };
  if (input.policy !== undefined) {
    if (!POLICIES.includes(input.policy as Policy)) return { ok: false, error: 'a policy is read, edit or full' };
    grant.policy = input.policy as Policy;
  }
  if (input.label?.trim()) grant.label = input.label.trim().slice(0, 80);
  host.grantsChanged();
  return { ok: true, value: undefined };
}

export function removeGrant(host: Host, grantId: string): OpResult {
  const before = host.cfg.grants.length;
  host.cfg.grants = host.cfg.grants.filter((g) => g.id !== grantId);
  if (host.cfg.grants.length === before) return { ok: false, error: 'no such grant' };
  host.grantsChanged();
  return { ok: true, value: undefined };
}
