# 동기화 서버 배포 (Oracle Free Tier VM)

## 1. 구성
- 서버는 OCI VM에서 `infra` 레포의 공용 Caddy 뒤에서 돈다. Caddy가 `dohyun06.is-a.dev/sync/*`를 외부 Docker 네트워크 `proxy`의 `sync-server:1234`로 넘긴다.
- 이 compose는 포트를 열지 않고 `proxy` 네트워크에만 붙는다. 프로젝트 이름은 `quilleaf`로 고정되어 있어 볼륨은 어디에 clone하든 `quilleaf_sync-data`다.

## 2. 배포
- `main`에 push하면 `.github/workflows/deploy.yml`이 검사 후 SSH로 서버의 `~/quilleaf-be`에서 `git merge --ff-only`와 `docker compose up -d --build`를 실행한다. Actions 탭에서 수동 실행도 된다.
- 레포 secret `SSH_KEY`, `SSH_KNOWN_HOSTS`, `SSH_TARGET`이 필요하다(다른 서비스 레포와 같은 값).
- 처음 설치하거나 손으로 띄울 때:

```bash
git clone https://github.com/dohyun06/quilleaf-be.git
cd quilleaf-be/deploy
docker compose up -d --build
```

## 3. 토큰 발급 (볼트마다)
```bash
docker compose exec sync-server node packages/server/dist/token.js token create my-vault-01
```
출력된 `token:` 값은 한 번만 표시된다. quilleaf 앱의 서버 동기화 설정에 바로 입력한다.

폐기와 목록:
```bash
docker compose exec sync-server node packages/server/dist/token.js token list
docker compose exec sync-server node packages/server/dist/token.js token revoke <tokenId>
```

## 3-1. 새 기기 연결 (코드 승인)
새 기기가 서버 주소를 넣고 연결 코드(예: `K7QM-2XPA`)를 보여 주면, 아래 셋 중 하나로 승인한다. 승인되면 그 기기가 자기 토큰을 받아 간다. 첫 기기는 1번이나 3번으로 승인한다. 코드는 10분 동안만 유효하다. 설계: `docs/superpowers/specs/2026-11-24-device-pairing-design.md`

1. GitHub Actions: Actions 탭에서 **Approve device**를 열고 Run workflow를 눌러 `code`와 `vault_id`를 입력한다.
2. `gh` CLI:
```bash
gh workflow run approve-device.yml -f code=K7QM-2XPA -f vault_id=my-vault-01
```
3. VM에서 CLI로:
```bash
docker compose exec sync-server node packages/server/dist/token.js pair approve K7QM-2XPA my-vault-01
```
이미 연결된 기기의 앱에서도 코드를 입력해 승인할 수 있다. 레포가 public이면 Actions 입력값이 공개되지만, 토큰은 새 기기만 받아 갈 수 있어서 코드가 알려져도 안전하다. 기기별 토큰에는 기기 이름이 라벨로 붙고(`token list`에 표시), 수동 발급 때는 `token create <vaultId> [label]`로 라벨을 줄 수 있다.
## 4. 백업
문서와 토큰 해시는 `sync-data` 볼륨의 `/app/data/sync.db`에 있다. 서버가 실행 중이어도 일관된 사본을 얻도록 SQLite의 `VACUUM INTO`로 스냅샷을 만든 뒤 꺼낸다. (DB가 WAL 모드라 파일을 그대로 tar로 묶으면 쓰기 도중의 상태가 담길 수 있다.)
```bash
docker compose exec sync-server node -e "require('node:fs').rmSync('/app/data/backup.db',{force:true});const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/app/data/sync.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker compose cp sync-server:/app/data/backup.db ./sync-backup.db
docker compose exec sync-server node -e "require('node:fs').rmSync('/app/data/backup.db')"
```
`./sync-backup.db`는 그 자체로 완결된 SQLite 파일이다. 확인: `sqlite3 sync-backup.db 'PRAGMA integrity_check;'`

첨부파일 블롭은 같은 볼륨의 `/app/data/blobs/<vaultId>/<sha256>`에 있다(환경 변수 `BLOB_DIR`로 바꿀 수 있고, 기본값은 DB 옆 `blobs/`). 파일 이름이 내용의 해시이고 한 번 쓰면 바뀌지 않아서 그대로 복사하면 된다. 서버는 블롭을 지우지 않는다(GC 없음).
```bash
docker compose cp sync-server:/app/data/blobs ./sync-blobs
```

## 5. 보안 메모
- Hocuspocus는 포트를 열지 않는다. 외부 접근은 공용 Caddy(80/443)를 거친다.
- 로그에는 토큰과 노트 내용이 남지 않는다.
- 첨부 블롭 API(`/sync/blobs/...`)도 같은 볼트 토큰(`Authorization: Bearer`)으로만 열린다. 파일 하나 최대 50 MiB. 설계: `docs/superpowers/specs/2026-11-23-attachment-sync-design.md`
