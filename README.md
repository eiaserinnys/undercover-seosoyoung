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
- `DISCORD_BOT_TOKEN`: Discord bot token. 비어 있으면 mock mode
- `DISCORD_MOCK_MODE`: `true`면 Gateway 연결 없이 seed 메시지 사용
- `DISCORD_GUILD_ALLOWLIST`: 쉼표 구분 guild id
- `DISCORD_CHANNEL_ALLOWLIST`: 쉼표 구분 channel id

## API

- `GET /healthz`
- `GET /api/messages?channelId=...&status=active|edited|deleted`
- `GET /api/settings`

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

## Haniel 등록 제안

서비스 이름: `undercover-seosoyoung`

```yaml
undercover-seosoyoung:
  repo: https://github.com/eiaserinnys/undercover-seosoyoung
  path: /home/eias/haniel-root/services/undercover-seosoyoung
  branch: main
  auto_apply: false
  build: pnpm install --frozen-lockfile && pnpm build
  run: pnpm start
  env:
    UNDERCOVER_PORT: "4318"
    UNDERCOVER_APP_BASE_URL: "http://127.0.0.1:4318"
    UNDERCOVER_DATABASE_PATH: ".data/undercover-seosoyoung.sqlite"
    DISCORD_MOCK_MODE: "true"
    DISCORD_GUILD_ALLOWLIST: ""
    DISCORD_CHANNEL_ALLOWLIST: ""
  ready_check:
    url: http://127.0.0.1:4318/healthz
```

실제 운영 등록 전 확인할 것:

- 포트 4318 충돌 여부
- Discord bot token Vault 반영
- guild id와 channel allowlist
- Message Content Intent 활성화
