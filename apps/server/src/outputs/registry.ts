/**
 * The output kinds this instance has. Adding a kind is a folder in `kinds/` and
 * one line here (ADR 0023). Order is the order of the **Add output** menu.
 *
 * Built-in only: a kind is code that runs beside credentials, and loading
 * someone else's safely is not designed (ADR 0019).
 */
import type { OutputKindModule } from './contract.ts';
import { doc } from './kinds/doc/index.ts';
import { latex } from './kinds/latex/index.ts';

export const KINDS: OutputKindModule[] = [doc, latex];
