// Pages opened from links in e-mails: choosing a new password, and confirming an address.

import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { navigate } from "../router.ts";
import { Wordmark } from "./Logo.tsx";

export function ResetPasswordPage({ token, onAuthenticated }: { token: string; onAuthenticated: (token: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) return setError("As senhas não são iguais.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.resetPassword(token, password);
      await onAuthenticated(r.token);
      navigate("/channels", true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <Wordmark />
        </div>
        <h1>Escolha uma nova senha</h1>
        <p className="muted">Depois de trocar, todos os dispositivos conectados à sua conta saem dela.</p>
        <label>
          Nova senha
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required autoFocus />
        </label>
        <label>
          Repita a nova senha
          <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" minLength={8} required />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary" disabled={busy}>
          Salvar e entrar
        </button>
      </form>
    </div>
  );
}

export function VerifyEmailPage({ token, signedIn }: { token: string; signedIn: boolean }) {
  const [state, setState] = useState<{ ok: true; email: string } | { ok: false; error: string } | null>(null);
  useEffect(() => {
    api.verifyEmail(token).then(
      (r) => setState({ ok: true, email: r.email }),
      (err) => setState({ ok: false, error: (err as Error).message }),
    );
  }, [token]);

  return (
    <div className="auth-page">
      <div className="auth-card center">
        <div className="auth-brand">
          <Wordmark />
        </div>
        {!state ? (
          <p className="muted">Confirmando…</p>
        ) : state.ok ? (
          <>
            <h1>E-mail confirmado</h1>
            <p className="muted">
              <strong>{state.email}</strong> agora pode ser usado para recuperar sua senha.
            </p>
          </>
        ) : (
          <>
            <h1>Não foi possível confirmar</h1>
            <p className="muted">{state.error}</p>
          </>
        )}
        <button className="btn primary" onClick={() => navigate("/channels", true)}>
          {signedIn ? "Voltar ao Voxa" : "Entrar"}
        </button>
      </div>
    </div>
  );
}
