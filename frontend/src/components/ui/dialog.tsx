import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

export function Dialog({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-lg border border-border-strong bg-surface p-0 text-fg backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button onClick={onClose} className="text-muted hover:text-fg" aria-label="Close dialog"><X className="size-4" /></button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
