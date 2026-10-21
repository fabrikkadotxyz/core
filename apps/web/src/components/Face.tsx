/**
 * Someone's face (M67, ADR 0061): their picture, or two letters on a colour.
 * Agents are rounded squares and never have a picture, so an agent is never
 * mistaken for a person. If a picture fails to load (signed out, removed
 * since), the initials show instead.
 */
import { useEffect, useState } from 'react';
import { faceColor, initialsOf } from '../face';

export function Face({
  name,
  seed,
  url,
  agent = false,
  size = 'sm',
  title,
}: {
  name: string;
  /** What the colour is taken from: the account id for a person, the participant id for an agent. */
  seed: string;
  url?: string | null;
  agent?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  title?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const picture = !agent && url && !broken ? url : null;
  return (
    <span
      className={`face face-${size}${agent ? ' face-agent' : ''}`}
      style={picture ? undefined : { background: `var(--face-${faceColor(seed)})` }}
      title={title ?? name}
      aria-hidden="true"
    >
      {picture ? <img src={picture} alt="" draggable={false} onError={() => setBroken(true)} /> : initialsOf(name)}
    </span>
  );
}
