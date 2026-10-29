import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { DOWNLOAD_URL, desktop } from "../desktop.ts";
import { Wordmark } from "./Logo.tsx";

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string) => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [canReset, setCanReset] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    api.authOptions().then((o) => setCanReset(o.passwordReset), () => {});
  }, []);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (mode === "forgot") {
      try {
        await api.forgotPassword(username);
        setSent(true);
      } catch (err) {
        setError((err as Error).message);
      }
      setBusy(false);
      return;
    }
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

  if (mode === "forgot") {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-brand">
            <Wordmark />
          </div>
          <h1>Esqueceu a senha?</h1>
          {sent ? (
            <p className="muted" role="status">
              Se essa conta tiver um e-mail confirmado, enviamos um link para criar uma nova senha. Ele vale por 1 hora — confira também a caixa de spam.
            </p>
          ) : (
            <>
              <p className="muted">Digite seu usuário ou o e-mail confirmado na conta. Enviaremos um link para criar uma nova senha.</p>
              <label>
                Usuário ou e-mail
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
              </label>
              {error && <div className="form-error">{error}</div>}
              <button className="btn primary" disabled={busy}>
                Enviar link
              </button>
            </>
          )}
          <p className="muted small">
            <button
              type="button"
              className="link"
              onClick={() => {
                setMode("login");
                setSent(false);
                setError(null);
              }}
            >
              Voltar para o login
            </button>
          </p>
        </form>
      </div>
    );
  }

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

        {isLogin && canReset && (
          <button type="button" className="link forgot-link" onClick={() => (setMode("forgot"), setError(null))}>
            Esqueci minha senha
          </button>
        )}

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
