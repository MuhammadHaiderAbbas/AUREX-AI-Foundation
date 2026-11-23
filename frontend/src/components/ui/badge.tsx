import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      tone: {
        neutral: "bg-surface-3 text-muted",
        accent: "bg-accent/15 text-accent",
        positive: "bg-positive/15 text-positive",
        negative: "bg-negative/15 text-negative",
        warning: "bg-warning/15 text-warning",
        info: "bg-info/15 text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function StatusDot({ tone = "neutral" }: { tone?: "positive" | "negative" | "warning" | "neutral" | "accent" }) {
  const color = {
    positive: "bg-positive", negative: "bg-negative", warning: "bg-warning", neutral: "bg-subtle", accent: "bg-accent",
  }[tone];
  return <span className={cn("inline-block size-1.5 rounded-full", color)} aria-hidden />;
}
