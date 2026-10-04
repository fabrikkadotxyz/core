/**
 * What a web kind module provides. See ADR 0023.
 *
 * `OutputView` draws what every kind shares — title, presence, tabs, delete —
 * and mounts the kind's body, loaded lazily so a kind's dependencies (the TeX
 * engine, a PDF renderer) are paid for only by outputs of that kind.
 */
import type { ComponentType, LazyExoticComponent } from 'react';
import type { Output, OutputEditSummary } from '@fabrikka/types';
import type { SessionRef } from '../../api.ts';
import type { OutputTab } from '../Outputs.tsx';
import type { OutputSync } from '../sync.ts';

export interface KindBodyProps {
  ref_: SessionRef;
  output: Output;
  sync: OutputSync;
  tab: OutputTab;
  onTab: (t: OutputTab) => void;
  /** An edit to show — from "Show me" in the timeline or the notice. */
  focusEdit: OutputEditSummary | null;
  /** Bumped whenever an edit to this output is published. */
  editsVersion: number;
  /** A viewer (M22): show, don't edit. The server enforces it regardless. */
  readOnly: boolean;
}

export interface WebKind {
  /** Tab labels. A null preview means the kind has no preview tab. */
  tabs: { edit: string; preview: string | null };
  /** Which tab "Show me" opens for an edit: the page it changed, or the diff. */
  showEditIn: OutputTab;
  /** Shown while the body loads. */
  loading?: string;
  Body: LazyExoticComponent<ComponentType<KindBodyProps>>;
}
