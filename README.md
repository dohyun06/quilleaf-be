# quilleaf-be

quilleaf 앱이 여러 기기의 노트를 충돌 없이 실시간으로 함께 편집하도록 돕는 동기화 서버입니다 (Yjs + Hocuspocus).

- 클라이언트(동기화 엔진)는 quilleaf 앱 레포 [`dohyun06/quilleaf`](https://github.com/dohyun06/quilleaf)의 `src/features/serversync`에 있습니다. 예전 Obsidian 플러그인은 그쪽으로 옮겨진 뒤 이 레포에서 지웠습니다.
- 설계와 프로토콜: [docs/superpowers/specs/2026-10-07-quilleaf-sync-design.md](docs/superpowers/specs/2026-10-07-quilleaf-sync-design.md)
- 서버 배포: [deploy/README.md](deploy/README.md)

## 구성

- `packages/server` (`@quilleaf/server`): Hocuspocus 서버. 문서는 `node:sqlite`에 저장하고 볼트마다 토큰으로 인증합니다.
- `packages/shared` (`@quilleaf/shared`): 문서 이름, 맵 키, 경로 규칙, 크기 제한처럼 서버와 클라이언트가 함께 지켜야 하는 값. quilleaf 앱이 `src/features/serversync/shared`에 같은 내용을 복사해 씁니다. 바꿀 때는 두 곳을 함께 맞춥니다.

## 개발

```bash
git clone https://github.com/dohyun06/quilleaf-be.git
cd quilleaf-be
npm install
npm run check
npm run build -w @quilleaf/server
```
