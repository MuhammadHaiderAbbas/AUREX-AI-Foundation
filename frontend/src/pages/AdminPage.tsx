import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { useState } from "react";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useAuth } from "@/features/auth/AuthProvider";
import { formatDateTime } from "@/lib/utils";
import { api, type AuditLog, type Page, type User } from "@/services/api";

function Users() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => api<Page<User>>("/admin/users?limit=200") });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<{ role: string; is_active: boolean }> }) =>
      api<User>(`/admin/users/${id}`, { method: "PATCH", json: body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-users"] }); qc.invalidateQueries({ queryKey: ["admin-audit"] }); },
  });
  return (
    <Card>
      <CardHeader title="Users" description="Role or status changes revoke the user's active sessions" />
      <ErrorBanner error={users.error ?? update.error} className="m-4" />
      {users.isLoading ? <div className="p-8"><Spinner className="mx-auto" /></div> : (
        <Table>
          <thead><tr><Th>User</Th><Th>Role</Th><Th>Status</Th><Th>Last login</Th><Th className="text-right">Actions</Th></tr></thead>
          <tbody>
            {users.data?.items.map((u) => (
              <Tr key={u.id}>
                <Td><div className="font-medium">{u.full_name}</div><div className="text-[11px] text-subtle">{u.email}</div></Td>
                <Td><Badge tone={u.role === "admin" ? "accent" : "neutral"}>{u.role}</Badge></Td>
                <Td><span className="flex items-center gap-1.5 text-xs"><StatusDot tone={u.is_active ? "positive" : "negative"} />{u.is_active ? "Active" : "Disabled"}</span></Td>
                <Td className="num text-xs text-muted">{u.last_login_at ? formatDateTime(u.last_login_at) : "—"}</Td>
                <Td className="space-x-2 text-right">
                  {u.id !== me?.id && (<>
                    <Button size="sm" variant="outline" onClick={() => update.mutate({ id: u.id, body: { role: u.role === "admin" ? "user" : "admin" } })}>
                      {u.role === "admin" ? "Make user" : "Make admin"}
                    </Button>
                    <Button size="sm" variant={u.is_active ? "danger" : "secondary"} onClick={() => update.mutate({ id: u.id, body: { is_active: !u.is_active } })}>
                      {u.is_active ? "Disable" : "Enable"}
                    </Button>
                  </>)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Audit() {
  const [action, setAction] = useState("");
  const audit = useQuery({
    queryKey: ["admin-audit", action],
    queryFn: () => api<Page<AuditLog>>(`/admin/audit?limit=100${action ? `&action=${encodeURIComponent(action)}` : ""}`),
  });
  const verify = useMutation({ mutationFn: () => api<{ valid: boolean; records_checked: number; first_invalid_id?: number; reason?: string }>("/admin/audit/verify") });
  return (
    <Card>
      <CardHeader title="Audit trail" description="Append-only, SHA-256 hash-chained"
        action={<Button size="sm" variant="secondary" onClick={() => verify.mutate()} disabled={verify.isPending}><ShieldCheck />Verify chain</Button>} />
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <Input placeholder="Filter by action, e.g. auth.login" className="max-w-xs" value={action} onChange={(e) => setAction(e.target.value.trim())} />
        {verify.data && (
          <span className={`flex items-center gap-1.5 text-xs ${verify.data.valid ? "text-positive" : "text-negative"}`}>
            {verify.data.valid ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
            {verify.data.valid ? `Chain intact — ${verify.data.records_checked} records verified` : `Tampering detected at record #${verify.data.first_invalid_id}: ${verify.data.reason}`}
          </span>
        )}
        <span className="ml-auto text-xs text-subtle">{audit.data?.total ?? 0} records</span>
      </div>
      {audit.isLoading ? <div className="p-8"><Spinner className="mx-auto" /></div> : (
        <Table>
          <thead><tr><Th>#</Th><Th>Time</Th><Th>Action</Th><Th>Outcome</Th><Th>Resource</Th><Th>IP</Th><Th>Hash</Th></tr></thead>
          <tbody>
            {audit.data?.items.map((r) => (
              <Tr key={r.id}>
                <Td className="num text-xs text-subtle">{r.id}</Td>
                <Td className="num text-xs text-muted">{formatDateTime(r.occurred_at)}</Td>
                <Td className="num text-xs">{r.action}</Td>
                <Td><Badge tone={r.outcome === "success" ? "positive" : "negative"}>{r.outcome}</Badge></Td>
                <Td className="text-xs text-muted">{r.resource_type ?? "—"}</Td>
                <Td className="num text-xs text-muted">{r.ip_address ?? "—"}</Td>
                <Td className="num text-[11px] text-subtle" title={r.hash}>{r.hash.slice(0, 12)}…</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function AdminPage() {
  return <div className="space-y-6"><Users /><Audit /></div>;
}
