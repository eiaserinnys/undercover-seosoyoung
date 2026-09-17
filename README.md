# undercover-seosoyoung

Discord 공식 서버를 더럽히지 않는 read-only 운영 대시보드입니다. 지정 guild/channel의 메시지를 수집해 SQLite에 저장하고, 내부 화면에서 원문·한국어 번역·Discord 딥링크를 확인하게 합니다.

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
- `UNDERCOVER_CORKSHEET_SSO_START_URL`: Corksheet SSO 브리지 시작 URL. 프로덕션은 `https://corksheet.eiaserinnys.me/auth/undercover/start`
- `UNDERCOVER_SSO_BRIDGE_SECRET`: Corksheet가 발급한 단기 handoff token 검증 secret. Corksheet와 같은 값
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`: 직접 Slack OAuth를 쓸 때의 Sign in with Slack 앱 credential. Corksheet SSO 브리지 모드에서는 필요하지 않음
- `SLACK_REDIRECT_URI`: 직접 Slack OAuth 콜백. Corksheet SSO 브리지 모드에서는 사용하지 않음
- `SLACK_TEAM_ID`: workspace-wide 허용 시 검사할 Slack workspace/team ID
- `UNDERCOVER_ALLOWED_SLACK_USER_IDS`: 쉼표 구분 Slack user ID allowlist
- `UNDERCOVER_ALLOW_WORKSPACE`: `true`면 `SLACK_TEAM_ID` workspace 전체 허용
- `DISCORD_BOT_TOKEN`: Discord bot token. 비어 있으면 mock mode
- `DISCORD_MOCK_MODE`: `true`면 Gateway 연결 없이 seed 메시지 사용
- `DISCORD_GUILD_ALLOWLIST`: 쉼표 구분 guild id
- `DISCORD_CHANNEL_ALLOWLIST`: 쉼표 구분 channel id
- `CODEX_CLI_PATH`: 번역에 사용할 Codex CLI 실행 파일의 절대 경로. 번역 모델은 `gpt-5.6-luna`로 고정
- `UNDERCOVER_SLACK_RELAY_ENABLED`: `true`일 때만 Slack 중계 활성화
- `UNDERCOVER_SLACK_RELAY_CHANNEL_ID`: 중계 대상 채널. 운영값 `C0C291S3YFM`
- `UNDERCOVER_SLACK_RELAY_BOT_USER_ID`: `auth.test`로 일치 여부를 확인할 봇 ID. 운영값 `U0A8XJZ6Q5S`
- `UNDERCOVER_SLACK_RELAY_ATTACHMENT_MAX_BYTES`: Discord 첨부를 Slack으로 옮길 때의 파일당 상한. 기본 `20971520`(20 MiB)
- `SLACK_BOT_TOKEN`: 중계 봇 토큰. 로그인 OAuth credential과 별개

공개 URL(`https://undercover.eiaserinnys.me`)에서는 `UNDERCOVER_ALLOWED_SLACK_USER_IDS` 또는
`UNDERCOVER_ALLOW_WORKSPACE=true` 중 하나가 반드시 명시되어야 합니다. workspace-wide 허용은
`SLACK_TEAM_ID`가 함께 있어야 합니다.

## API

- `GET /healthz`
- `GET /api/me`
- `GET /api/messages?channelId=...&status=active|edited|deleted`
- `GET /api/message-events`
- `GET /api/settings`
- `GET /auth/slack`
- `GET /auth/slack/callback`
- `GET /auth/corksheet/callback`
- `POST /auth/logout`

쓰기 API는 없습니다. Discord 발신 endpoint도 없습니다.

`/api/message-events`는 인증 뒤에서 동작하는 SSE 스트림입니다. `Last-Event-ID` 헤더 또는 `lastEventId` query를 기준으로 누락된 메시지 변경을 backfill하고, 이후 수집·수정·삭제·번역 완료 이벤트를 push합니다.

## 번역 저장과 마이그레이션

메시지 저장 시 `content_hash`를 함께 저장합니다. 원문이 바뀌지 않은 messageUpdate는 기존 번역을 보존하고, 원문이 바뀐 경우에만 `translation_status=pending`으로 되돌려 재번역합니다.

신규·수정 이벤트의 번역은 격리된 Codex `exec --ephemeral` 프로세스가 담당합니다. 임시 작업 디렉터리, 읽기 전용 sandbox, 제한된 환경변수를 사용하며 source는 stdin으로만 전달합니다. 배포 시작 시 과거 `pending` 행을 일괄 재번역하지 않습니다. 번역 실패는 해당 행에 남겨 재시도하고 Discord 수집은 계속됩니다.

기존 SQLite 파일은 앱 시작 시 다음 컬럼을 자동 추가합니다.

- `content_hash`
- `translation_status`
- `translation_error`
- `translated_at`
- `attachments_json`

수동 DB migration 명령은 필요 없습니다.

## Slack 중계

릴레이를 처음 초기화할 때 이미 DB에 있던 message ID는 영구적으로 `baseline_excluded`가 되어 발송되지 않습니다. 그 뒤 처음 들어온 ID만 굵은 `🔗 화자 | 채널` 헤더와 빈 줄 뒤 한국어 번역 전문을 하나의 `rich_text` section으로 전송하며, 같은 ID의 수정과 삭제는 기존 Slack 메시지에 반영합니다. 상태와 Slack `ts`는 같은 SQLite 파일에 저장되어 중복 이벤트나 재시작이 중복 발송을 만들지 않습니다.

Discord 첨부가 있으면 서명된 `cdn.discordapp.com/attachments/...` 원본만 내려받아 Slack 공식 외부 업로드 3단계로 부모 메시지의 thread에 묶습니다. 봇 토큰에는 `files:write` scope가 필요합니다. 파일당 기본 20 MiB 상한을 넘거나 다운로드·Slack 업로드가 실패하면 텍스트 중계는 유지하고 부모 메시지에 Discord 원본 링크를 남깁니다. 업로드 도중 재시작된 첨부는 중복 방지를 위해 자동 재업로드하지 않고 링크 fallback으로 확정합니다. 본문 없이 첨부만 있는 메시지도 헤더와 첨부를 전달합니다.

운영 예외는 로그의 message ID와 `slack_relay_state`에 남습니다.

- `unknown`: post 응답을 받지 못해 성공 여부가 불명확합니다. 자동 재전송하지 말고 대상 채널을 먼저 확인한 뒤 상태를 수동 조정합니다.
- `too_long`: 원문을 자르지 않습니다. Discord 원문이 제한 아래로 수정되면 다시 처리됩니다.
- `empty`: 본문과 첨부가 모두 없는 메시지는 보내지 않습니다. 내용이나 첨부가 추가되면 다시 처리됩니다.

## Slack 로그인 운영 흐름

프로덕션 Slack 앱에는 새 redirect URL을 추가하지 않는다. Undercover는 Corksheet의 기존 Slack 앱과 콜백을 SSO 브리지로 재사용한다.

1. Undercover `/auth/slack`이 `UNDERCOVER_CORKSHEET_SSO_START_URL`로 이동한다.
2. Corksheet `/auth/undercover/start`가 기존 Better-Auth Slack 로그인을 시작한다.
3. Slack은 기존 등록 콜백 `https://corksheet.eiaserinnys.me/auth/callback/slack`으로만 돌아온다.
4. Corksheet `/auth/undercover/complete`가 60초 handoff token을 발급해 Undercover `/auth/corksheet/callback`으로 돌려보낸다.
5. Undercover가 token을 검증하고 allowlist/team 정책을 적용한 뒤 `undercover_session` 쿠키를 발급한다.

브리지 모드에서 Undercover에 필요한 운영 env:

```dotenv
UNDERCOVER_CORKSHEET_SSO_START_URL=https://corksheet.eiaserinnys.me/auth/undercover/start
UNDERCOVER_SSO_BRIDGE_SECRET=
UNDERCOVER_SESSION_SECRET=
UNDERCOVER_ALLOWED_SLACK_USER_IDS=U08HWT0C6K1
UNDERCOVER_ALLOW_WORKSPACE=false
```

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
    run: bash -lc 'set -a && source /home/eias/services/undercover-seosoyoung/shared/.env && set +a && exec /home/eias/services/undercover-seosoyoung/shared/node-v24.18.0-linux-x64/bin/node dist/server/server/index.js'
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
SHARED_DIR="/home/eias/services/undercover-seosoyoung/shared"
NODE_VERSION="24.18.0"
NODE_DIR="$SHARED_DIR/node-v${NODE_VERSION}-linux-x64"
NODE_TARBALL="$SHARED_DIR/node-v${NODE_VERSION}-linux-x64.tar.xz"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing undercover-seosoyoung env file: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  mkdir -p "$SHARED_DIR"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "$NODE_TARBALL"
  tar -xJf "$NODE_TARBALL" -C "$SHARED_DIR"
fi

unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE NODE_UNIQUE_ID

export PATH="$NODE_DIR/bin:$PATH"

pnpm --dir "$APP_DIR" install --frozen-lockfile
pnpm --dir "$APP_DIR" build
```

shared env:

```dotenv
UNDERCOVER_PORT=4318
UNDERCOVER_APP_BASE_URL=https://undercover.eiaserinnys.me
UNDERCOVER_DATABASE_PATH=/home/eias/services/undercover-seosoyoung/shared/undercover-seosoyoung.sqlite
UNDERCOVER_DASHBOARD_TITLE=암행 서소영

UNDERCOVER_CORKSHEET_SSO_START_URL=https://corksheet.eiaserinnys.me/auth/undercover/start
UNDERCOVER_SSO_BRIDGE_SECRET=
SLACK_TEAM_ID=
UNDERCOVER_SESSION_SECRET=
UNDERCOVER_ALLOWED_SLACK_USER_IDS=U08HWT0C6K1
UNDERCOVER_ALLOW_WORKSPACE=false

DISCORD_BOT_TOKEN=
DISCORD_MOCK_MODE=true
DISCORD_GUILD_ALLOWLIST=
DISCORD_CHANNEL_ALLOWLIST=
DISCORD_CLIENT_ID=

CODEX_CLI_PATH=

UNDERCOVER_SLACK_RELAY_ENABLED=false
UNDERCOVER_SLACK_RELAY_CHANNEL_ID=C0C291S3YFM
UNDERCOVER_SLACK_RELAY_BOT_USER_ID=U0A8XJZ6Q5S
UNDERCOVER_SLACK_RELAY_ATTACHMENT_MAX_BYTES=20971520
SLACK_BOT_TOKEN=
```

## eiaserinnys 공개 준비

- 포트: `4318` (`ss -tlnp` 기준 현재 비어 있음)
- DNS: `undercover.eiaserinnys.me` → eiaserinnys 노드 public IP
- nginx: `xops.eiaserinnys.me`와 같은 reverse proxy 형태로 `http://127.0.0.1:4318`에 연결
- TLS: DNS 전파 후 `certbot --nginx -d undercover.eiaserinnys.me`
- Slack app redirect URL 추가 없음. 기존 Corksheet 콜백 `https://corksheet.eiaserinnys.me/auth/callback/slack`을 재사용
- Node runtime: eiaserinnys 기본 `/usr/bin/node`는 Node 20일 수 있으므로, hook이 shared 폴더에 Node 24.18.0을 준비하고 서비스도 그 바이너리로 실행합니다.

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
