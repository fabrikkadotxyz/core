/**
 * Built-in templates. Adding one is a file in `builtin/` and one line here —
 * the same plug-in shape as output kinds (ADR 0023). Plain data: an instance's
 * operator can edit or remove them like any other file.
 */
import type { TemplateBody } from '@fabrikka/types';
import { incident } from './builtin/incident.ts';
import { onboarding } from './builtin/onboarding.ts';
import { shaping } from './builtin/shaping.ts';

export interface BuiltinTemplate {
  /** Stable: sessions record "builtin:<id>". Never rename one. */
  id: string;
  name: string;
  description: string;
  body: TemplateBody;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [shaping, incident, onboarding];
