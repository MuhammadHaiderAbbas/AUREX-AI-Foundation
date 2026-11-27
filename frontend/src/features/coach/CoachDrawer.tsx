import { useMutation } from "@tanstack/react-query";
import { GraduationCap, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";
import { api, ApiError, isDemo } from "@/services/api";

interface Answer { answer: string; facts: string[]; engine: string; suggestions: string[] }
interface Msg { role: "user" | "assistant"; content: string; meta?: Answer }
const START = ["Why is my bot losing?", "Why did the AI say no trade?", "How am I doing?", "What is break-even win rate?", "What is leverage?"];

/** "Explain it to me": a coach that answers from the trader's own account data. */
export function CoachDrawer() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (question: string) => api<Answer>("/coach/ask", { method: "POST", json: {
      question, history: msgs.slice(-6).map(({ role, content }) => ({ role, content })) } }),
    onSuccess: (a) => setMsgs((m) => [...m, { role: "assistant", content: a.answer, meta: a }]),
    onError: (e) => setMsgs((m) => [...m, { role: "assistant", content: e instanceof ApiError ? e.message : "Something went wrong. Please try again." }]),
  });
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, ask.isPending]);
  const send = (text: string) => {
    const t = text.trim();
    if (t.length < 2 || ask.isPending) return;
    setMsgs((m) => [...m, { role: "user", content: t }]);
    setQ("");
    ask.mutate(t);
  };
  const last = [...msgs].reverse().find((m) => m.meta)?.meta;
  const suggestions = (last?.suggestions ?? START).filter((s) => !msgs.some((m) => m.role === "user" && m.content === s)).slice(0, 4);
  return (
    <>
      <button onClick={() => setOpen(!open)} data-tour="coach" data-testid="coach-button" aria-expanded={open}
        className="fixed right-4 bottom-20 z-40 flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg shadow-xl shadow-black/40 hover:bg-accent/90 lg:bottom-5 print:hidden">
        <GraduationCap className="size-4" />{open ? "Close coach" : "Ask the coach"}
      </button>
      {open && (
        <aside role="dialog" aria-label="Coach" data-testid="coach"
          className="fixed right-4 bottom-36 z-40 flex h-[min(560px,calc(100vh-200px))] w-[min(400px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-border bg-surface-2 shadow-2xl shadow-black/60 lg:bottom-20">
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold"><GraduationCap className="size-4 text-accent" />Explain it to me</h2>
              <p className="text-xs text-subtle">Answers from your own trades, bot and AI desk. Not financial advice.</p>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close coach" className="text-muted hover:text-fg"><X className="size-4" /></button>
          </header>
          <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
            {msgs.length === 0 && <p className="text-muted">Hi! Ask me why your bot won or lost, why the AI desk did or didn't trade, how your account is doing, or what a trading term means.</p>}
            {msgs.map((m, i) => (
              <div key={i} className={cn("max-w-[90%] whitespace-pre-line rounded-xl px-3 py-2 leading-relaxed", m.role === "user" ? "ml-auto bg-accent/15 text-fg" : "bg-surface-3 text-fg")}
                data-testid={m.role === "assistant" ? "coach-answer" : undefined}>
                {m.content}
                {m.meta && <div className="mt-1.5 text-[10px] text-subtle">{m.meta.engine.startsWith("claude") ? "Written by Claude from your data" : "Built-in explanation"}{m.meta.facts.length ? ` · based on: ${m.meta.facts.join(", ")}` : ""}</div>}
              </div>
            ))}
            {ask.isPending && <div className="flex items-center gap-2 text-xs text-muted"><Spinner />Thinking…</div>}
            <div ref={end} />
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-border px-4 pt-3">
              {suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:border-accent/60 hover:text-fg">{s}</button>)}
            </div>
          )}
          <form className="flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); send(q); }}>
            <input aria-label="Ask the coach" value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} placeholder="Ask a question…"
              className="h-9 flex-1 rounded-lg border border-border-strong bg-surface px-3 text-sm placeholder:text-subtle focus:border-accent focus:outline-none" />
            <Button type="submit" size="icon" aria-label="Send" disabled={q.trim().length < 2 || ask.isPending}><Send /></Button>
          </form>
          {isDemo && <p className="border-t border-border px-4 py-2 text-[10px] text-subtle">Demo: built-in explanations. On your own server the coach can use Claude with your API key.</p>}
        </aside>
      )}
    </>
  );
}
