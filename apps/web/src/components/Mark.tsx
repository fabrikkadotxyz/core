/**
 * The Fabrikka mark (brand/README.md): a factory made of three puzzle pieces.
 * One colour (currentColor), square, transparent.
 *
 * With `assemble`, the three pieces arrive from apart and join, once, when the
 * mark appears: separate parts, one plant. The pieces are the mark's own
 * silhouette clipped along its two cuts, so what lands is exactly the mark.
 * People who asked for reduced motion see it already assembled.
 */
import { useId } from 'react';

const BODY = 'M248 208 L368 296 V208 L488 296 V208 L605 296 H648 L668 68 H737 L757 296 H775 V503 H248 Z';
/** The two cuts, as drawn in brand/fabrikka-mark.svg: a vertical line with a knob to the right. */
const CUT_A = 'V370 C413 381 424 382 431 375 A33 33 0 1 1 431 429 C424 422 413 423 413 434';
const CUT_B = 'V370 C610 381 621 382 628 375 A33 33 0 1 1 628 429 C621 422 610 423 610 434';
/** The same cuts, walked upwards, to close the middle and right pieces. */
const CUT_A_UP = 'V434 C413 423 424 422 431 429 A33 33 0 1 0 431 375 C424 382 413 381 413 370';
const CUT_B_UP = 'V434 C610 423 621 422 628 429 A33 33 0 1 0 628 375 C621 382 610 381 610 370';

export function Mark({ size = 48, assemble = false, className }: { size?: number; assemble?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  const cuts = `mark-cuts-${id}`;
  const body = `mark-body-${id}`;
  const clip = (n: string) => `mark-piece-${n}-${id}`;
  return (
    <svg
      className={['mark', assemble ? 'mark-assemble' : '', className ?? ''].join(' ').trim()}
      width={size}
      height={size}
      viewBox="238 12 547 547"
      fill="currentColor"
      role="img"
      aria-label="Fabrikka"
    >
      <defs>
        <path id={body} d={BODY} />
        <mask id={cuts} maskUnits="userSpaceOnUse" x="238" y="12" width="547" height="547">
          <rect x="238" y="12" width="547" height="547" fill="#fff" />
          <g fill="none" stroke="#000" strokeWidth="10" strokeLinejoin="round">
            <path d={`M413 180 ${CUT_A} V520`} />
            <path d={`M610 180 ${CUT_B} V520`} />
          </g>
        </mask>
        <clipPath id={clip('a')}>
          <path d={`M238 12 H413 V180 ${CUT_A} V559 H238 Z`} />
        </clipPath>
        <clipPath id={clip('b')}>
          <path d={`M413 12 H610 V180 ${CUT_B} V559 H413 ${CUT_A_UP} V180 Z`} />
        </clipPath>
        <clipPath id={clip('c')}>
          <path d={`M610 12 H785 V559 H610 ${CUT_B_UP} V180 Z`} />
        </clipPath>
      </defs>
      <g className="mark-piece mark-piece-a" clipPath={`url(#${clip('a')})`}>
        <use href={`#${body}`} mask={`url(#${cuts})`} />
      </g>
      <g className="mark-piece mark-piece-b" clipPath={`url(#${clip('b')})`}>
        <use href={`#${body}`} mask={`url(#${cuts})`} />
      </g>
      <g className="mark-piece mark-piece-c" clipPath={`url(#${clip('c')})`}>
        <use href={`#${body}`} mask={`url(#${cuts})`} />
      </g>
    </svg>
  );
}
