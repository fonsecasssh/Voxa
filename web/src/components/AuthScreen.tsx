import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { DOWNLOAD_URL, desktop } from "../desktop.ts";
import { Wordmark } from "./Logo.tsx";

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string) => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } =
        mode === "login"
          ? await api.login(username, password)
          : await api.register(username, password, displayName || undefined);
      await onAuthenticated(token);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const isLogin = mode === "login";

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <Wordmark />
        </div>
        <h1>{isLogin ? "Boas-vindas de volta!" : "Criar uma conta"}</h1>
        <p className="muted">{isLogin ? "Que bom te ver de novo." : "Servidores, voz e amigos."}</p>

        <label>
          Usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        {!isLogin && (
          <label>
            Nome de exibição <span className="muted">(opcional)</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
          </label>
        )}
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? "current-password" : "new-password"}
            minLength={isLogin ? undefined : 8}
            required
          />
        </label>

        {error && <div className="form-error">{error}</div>}

        <button className="btn primary" disabled={busy}>
          {isLogin ? "Entrar" : "Continuar"}
        </button>

        <p className="muted small">
          {isLogin ? "Precisa de uma conta? " : "Já tem uma conta? "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(isLogin ? "register" : "login");
              setError(null);
            }}
          >
            {isLogin ? "Cadastre-se" : "Entrar"}
          </button>
        </p>
      </form>
      {!desktop && (
        <a className="download-link" href={DOWNLOAD_URL}>
          ⬇ Baixar o Voxa para Windows
        </a>
      )}
    </div>
  );
}
