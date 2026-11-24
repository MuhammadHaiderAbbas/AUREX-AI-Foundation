import { CalendarClock, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { NavItem } from "@/components/layout/nav";

const PLANS: Record<string, { summary: string; items: string[] }> = {
};

export function ModulePage({ item }: { item: NavItem }) {
  const plan = PLANS[item.to];
  return (
    <Card className="mx-auto max-w-3xl">
      <CardHeader title={<span className="flex items-center gap-2"><item.icon className="size-4 text-accent" />{item.label}</span>}
        description={plan?.summary ?? item.description}
        action={<Badge tone="info"><CalendarClock className="size-3" />Phase {item.phase}</Badge>} />
      <CardBody>
        <p className="text-sm text-muted">This module is not part of the Foundation release. It is scheduled for Phase {item.phase} and will ship only once its tests pass.</p>
        <ul className="mt-4 space-y-2">
          {plan?.items.map((i) => (
            <li key={i} className="flex items-start gap-2 text-sm"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-subtle" />{i}</li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
