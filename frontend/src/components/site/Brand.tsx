import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export function Brand({ to = "/", className, compact = false }: { to?: string; className?: string; compact?: boolean }) {
  return (
    <Link to={to} className={cn("flex items-center gap-2.5", className)} aria-label="AUREX AI home">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-7" />
      <span className="text-[15px] font-bold tracking-[0.14em]">AUREX{!compact && <span className="text-accent"> AI</span>}</span>
    </Link>
  );
}
