import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import * as api from "./api.js";
import type { CurrentUser } from "./api.js";

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-reads the signed-in user, e.g. after a password change clears mustChangePassword. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .fetchMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const loggedInUser = await api.login(email, password);
    setUser(loggedInUser);
  }

  async function refresh() {
    setUser(await api.fetchMe());
  }

  async function logout() {
    await api.logout();
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
