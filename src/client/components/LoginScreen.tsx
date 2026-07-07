export function LoginScreen({ error }: { error: string | null }) {
  return (
    <main className="login-shell">
      <section className="login-panel" aria-label="Slack 로그인">
        <p className="eyebrow">Discord Ops</p>
        <h1>암행 서소영</h1>
        {error ? <div className="notice error">{error}</div> : null}
        <a className="slack-login-button" href="/auth/slack?next=/">
          Slack으로 로그인
        </a>
      </section>
    </main>
  );
}
