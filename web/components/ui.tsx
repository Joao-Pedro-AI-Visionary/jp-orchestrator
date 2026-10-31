"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Inbox } from "lucide-react";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

export function Pill({ label, text, bg, testId }: { label: string; text: string; bg: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold ${text} ${bg}`}
    >
      {label}
    </span>
  );
}

export function EmptyState({ text, testId }: { text: string; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-slate-400"
    >
      <Inbox className="size-6" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

export function ErrorNote({ text, onRetry, testId }: { text: string; onRetry?: () => void; testId?: string }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{text}</span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Tentar novamente
        </button>
      )}
    </div>
  );
}

export function AnimatedNumber({
  value,
  format,
  testId,
}: {
  value: number;
  format: (n: number) => string;
  testId?: string;
}) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const controls = animate(from.current, value, {
      duration: reduce ? 0 : 0.9,
      ease: "easeOut",
      onUpdate: (v) => {
        from.current = v;
        setShown(v);
      },
    });
    return () => controls.stop();
  }, [value, reduce]);
  return (
    <span data-testid={testId} data-value={value} className="tabular-nums">
      {format(shown)}
    </span>
  );
}

export function ProgressBar({ ratio, tone = "bg-indigo-400", label }: { ratio: number; tone?: string; label: string }) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-2 w-full overflow-hidden rounded-full bg-white/10"
    >
      <div className={`h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
