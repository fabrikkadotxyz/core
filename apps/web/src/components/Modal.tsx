/**
 * A modal over the page (M52, ADR 0049): the browser's own <dialog>, opened
 * modally so focus stays inside, Escape closes it, and the page behind is
 * dimmed by its backdrop. A click on the backdrop closes it too.
 */
import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Only the backdrop: a click inside the dialog's box has a target within it.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
