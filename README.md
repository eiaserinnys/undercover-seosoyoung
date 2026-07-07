# undercover-seosoyoung

Discord 공식 서버를 더럽히지 않는 read-only 운영 대시보드입니다. MVP는 지정 guild/channel의 메시지를 수집해 SQLite에 저장하고, 내부 화면에서 원문과 Discord 딥링크를 확인하게 합니다.

## 원칙

- Discord에는 쓰지 않습니다.
- Send Messages 권한을 전제로 하지 않습니다.
- user token/selfbot 방식을 쓰지 않습니다.
- 토큰이 없으면 mock mode로 기동합니다.

## 개발

```bash
pnpm install
pnpm test
pnpm build
pnpm dev:server
```

대시보드 개발 서버:

```bash
pnpm dev
```

## 환경변수

`.env.example`을 참고해 `.env` 또는 Haniel 서비스 환경에 설정합니다.

- `UNDERCOVER_PORT`: 기본 4318
- `UNDERCOVER_APP_BASE_URL`: 대시보드 외부 기준 URL
- `UNDERCOVER_DATABASE_PATH`: SQLite 파일 경로
- `UNDERCOVER_SESSION_SECRET`: Slack 로그인 세션 쿠키 암호화 secret
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`: Sign in with Slack 앱 credential
- `SLACK_REDIRECT_URI`: `https://undercover.eiaserinnys.me/auth/slack/callback`
- `SLACK_TEAM_ID`: workspace-wide 허용 시 검사할 Slack workspace/team ID
- `UNDERCOVER_ALLOWED_SLACK_USER_IDS`: 쉼표 구분 Slack user ID allowlist
- `UNDERCOVER_ALLOW_WORKSPACE`: `true`면 `SLACK_TEAM_ID` workspace 전체 허용
- `DISCORD_BOT_TOKEN`: Discord bot token. 비어 있으면 mock mode
- `DISCORD_MOCK_MODE`: `true`면 Gateway 연결 없이 seed 메시지 사용
- `DISCORD_GUILD_ALLOWLIST`: 쉼표 구분 guild id
- `DISCORD_CHANNEL_ALLOWLIST`: 쉼표 구분 channel id

공개 URL(`https://undercover.eiaserinnys.me`)에서는 `UNDERCOVER_ALLOWED_SLACK_USER_IDS` 또는
`UNDERCOVER_ALLOW_WORKSPACE=true` 중 하나가 반드시 명시되어야 합니다. workspace-wide 허용은
`SLACK_TEAM_ID`가 함께 있어야 합니다.

## API

- `GET /healthz`
- `GET /api/me`
- `GET /api/messages?channelId=...&status=active|edited|deleted`
- `GET /api/settings`
- `GET /auth/slack`
- `GET /auth/slack/callback`
- `POST /auth/logout`

쓰기 API는 없습니다. Discord 발신 endpoint도 없습니다.

## Discord 권한

필요:

- View Channels
- Read Message History
- Message Content Intent

부여하지 말 것:

- Send Messages
- Manage Messages
- Use Webhooks

## eiaserinnys Haniel 등록 제안

서비스 이름: `undercover-seosoyoung`

```yaml
repos:
  undercover-seosoyoung:
    url: git@github.com:eiaserinnys/undercover-seosoyoung.git
    branch: main
    path: ./services/undercover-seosoyoung
    auto_apply: false
    pull_strategy: force

services:
  undercover-seosoyoung:
    enabled: true
    run: bash -lc 'set -a && source /home/eias/services/undercover-seosoyoung/shared/.env && set +a && exec /usr/bin/node dist/server/server/index.js'
    cwd: ./services/undercover-seosoyoung
    repo: undercover-seosoyoung
    ready: port:4318
    restart_delay: 10
    hooks:
      post_pull: /home/eias/services/haniel/bin/build-undercover-seosoyoung.sh
```

post_pull hook:

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/eias/services/haniel/services/undercover-seosoyoung"
ENV_FILE="/home/eias/services/undercover-seosoyoung/shared/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing undercover-seosoyoung env file: $ENV_FILE" >&2
  exit 1
fi

unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE NODE_UNIQUE_ID

pnpm --dir "$APP_DIR" install --frozen-lockfile
pnpm --dir "$APP_DIR" build
```

shared env:

```dotenv
UNDERCOVER_PORT=4318
UNDERCOVER_APP_BASE_URL=https://undercover.eiaserinnys.me
UNDERCOVER_DATABASE_PATH=/home/eias/services/undercover-seosoyoung/shared/undercover-seosoyoung.sqlite
UNDERCOVER_DASHBOARD_TITLE=암행 서소영

SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=https://undercover.eiaserinnys.me/auth/slack/callback
SLACK_TEAM_ID=
UNDERCOVER_SESSION_SECRET=
UNDERCOVER_ALLOWED_SLACK_USER_IDS=U08HWT0C6K1
UNDERCOVER_ALLOW_WORKSPACE=false

DISCORD_BOT_TOKEN=
DISCORD_MOCK_MODE=true
DISCORD_GUILD_ALLOWLIST=
DISCORD_CHANNEL_ALLOWLIST=
DISCORD_CLIENT_ID=
```

## eiaserinnys 공개 준비

- 포트: `4318` (`ss -tlnp` 기준 현재 비어 있음)
- DNS: `undercover.eiaserinnys.me` → eiaserinnys 노드 public IP
- nginx: `xops.eiaserinnys.me`와 같은 reverse proxy 형태로 `http://127.0.0.1:4318`에 연결
- TLS: DNS 전파 후 `certbot --nginx -d undercover.eiaserinnys.me`
- Slack app redirect URL: `https://undercover.eiaserinnys.me/auth/slack/callback`

nginx server block 예시:

```nginx
server {
    server_name undercover.eiaserinnys.me;

    location / {
        proxy_pass http://127.0.0.1:4318;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

실제 운영 등록 전 확인할 것:

- 포트 4318 충돌 여부
- Discord bot token Vault 반영
- guild id와 channel allowlist
- Message Content Intent 활성화
- Slack app credential과 `SLACK_TEAM_ID`
- 디렉터님 Slack user ID allowlist 최종 확정
