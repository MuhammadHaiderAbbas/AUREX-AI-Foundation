import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAccounts } from "@/features/accounts/hooks";

/** The selected paper account, kept in ?account= so links and reloads keep it. */
export function useAccountParam() {
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const list = accounts.data ?? [];
  const account = list.find((a) => a.id === params.get("account")) ?? list[0];
  useEffect(() => {
    if (account && params.get("account") !== account.id) {
      const next = new URLSearchParams(params); next.set("account", account.id);
      setParams(next, { replace: true });
    }
  }, [account, params, setParams]);
  const select = (id: string) => { const next = new URLSearchParams(params); next.set("account", id); setParams(next); };
  return { accounts, list, account, select, params, setParams };
}
