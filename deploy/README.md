# 동기화 서버 배포 (Oracle Free Tier VM)

## 1. 구성
- 서버는 OCI VM에서 `infra` 레포의 공용 Caddy 뒤에서 돈다. Caddy가 `dohyun06.is-a.dev/sync/*`를 외부 Docker 네트워크 `proxy`의 `sync-server:1234`로 넘긴다.
- 이 compose는 포트를 열지 않고 `proxy` 네트워크에만 붙는다. 프로젝트 이름은 `deploy`로 고정되어 있어 기존 `deploy_sync-data` 볼륨을 그대로 쓴다.

## 2. 배포
- `main`에 push하면 `.github/workflows/deploy.yml`이 검사 후 SSH로 서버의 `~/obsidian-crdt`에서 `git merge --ff-only`와 `docker compose up -d --build`를 실행한다. Actions 탭에서 수동 실행도 된다.
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
출력된 `token:` 값은 한 번만 표시된다. 플러그인 설정에 바로 입력한다.

폐기와 목록:
```bash
docker compose exec sync-server node packages/server/dist/token.js token list
docker compose exec sync-server node packages/server/dist/token.js token revoke <tokenId>
```

## 4. 백업
문서와 토큰 해시는 `sync-data` 볼륨의 `/app/data/sync.db`에 있다. 서버가 실행 중이어도 일관된 사본을 얻도록 SQLite의 `VACUUM INTO`로 스냅샷을 만든 뒤 꺼낸다. (DB가 WAL 모드라 파일을 그대로 tar로 묶으면 쓰기 도중의 상태가 담길 수 있다.)
```bash
docker compose exec sync-server node -e "require('node:fs').rmSync('/app/data/backup.db',{force:true});const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/app/data/sync.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker compose cp sync-server:/app/data/backup.db ./sync-backup.db
docker compose exec sync-server node -e "require('node:fs').rmSync('/app/data/backup.db')"
```
`./sync-backup.db`는 그 자체로 완결된 SQLite 파일이다. 확인: `sqlite3 sync-backup.db 'PRAGMA integrity_check;'`

## 5. 보안 메모
- Hocuspocus는 포트를 열지 않는다. 외부 접근은 공용 Caddy(80/443)를 거친다.
- 로그에는 토큰과 노트 내용이 남지 않는다.
