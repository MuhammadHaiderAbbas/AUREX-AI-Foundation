import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, refreshSession, tokenStore, type TokenResponse, type User } from "@/services/api";

type Status = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: Status;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, fullName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<User | null>(null);

  const clear = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
    setStatus("anonymous");
    qc.clear();
  }, [qc]);

  useEffect(() => {
    tokenStore.onSessionLost(clear);
    // Restore the session from the httpOnly refresh cookie (deduped in refreshSession).
    refreshSession().then((res) => {
      if (res) { setUser(res.user); setStatus("authenticated"); } else setStatus("anonymous");
    });
  }, [clear]);

  const value = useMemo<AuthContextValue>(() => ({
    status,
    user,
    async login(email, password) {
      const res = await api<TokenResponse>("/auth/login", { method: "POST", json: { email, password } });
      tokenStore.set(res.access_token);
      setUser(res.user);
      setStatus("authenticated");
    },
    async register(email, fullName, password) {
      await api<User>("/auth/register", { method: "POST", json: { email, full_name: fullName, password } });
    },
    async logout() {
      await api("/auth/logout", { method: "POST" }).catch(() => undefined);
      clear();
    },
  }), [status, user, clear]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
