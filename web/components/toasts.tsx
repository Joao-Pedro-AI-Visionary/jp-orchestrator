"use client";

import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, X, XCircle } from "lucide-react";
import type { Dashboard } from "@/lib/use-dashboard";

export function Toasts({ d }: { d: Dashboard }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2" data-testid="toasts">
      <AnimatePresence>
        {d.toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: 40 }}
            role={t.kind === "error" ? "alert" : "status"}
            data-testid={t.kind === "error" ? "toast-error" : "toast-success"}
            className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm shadow-xl backdrop-blur ${
              t.kind === "error" ? "border-rose-400/40 bg-rose-950/90 text-rose-100" : "border-emerald-400/40 bg-emerald-950/90 text-emerald-100"
            }`}
          >
            {t.kind === "error" ? <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            <p className="flex-1">{t.text}</p>
            <button type="button" aria-label="Fechar aviso" className="btn !min-h-11 !min-w-11 !px-1" onClick={() => d.dismissToast(t.id)}>
              <X className="size-4" aria-hidden="true" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
