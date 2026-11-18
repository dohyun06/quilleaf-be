# quilleaf-be

Obsidian 노트를 여러 기기에서 충돌 없이 실시간으로 함께 편집하는 동기화 서버와 Obsidian 플러그인(CRDT Sync)입니다 (Yjs + Hocuspocus).
같은 서버를 quilleaf 앱도 씁니다.

- 설계: [docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md](docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md)
- 서버 배포: [deploy/README.md](deploy/README.md)
- 실제 Obsidian 검증 목록: [docs/manual-verification.md](docs/manual-verification.md)

## 개발

```bash
git clone https://github.com/dohyun06/quilleaf-be.git
cd quilleaf-be
npm install
npm run check
npm run build -w @obsidian-crdt/plugin
npm run install-dev -w @obsidian-crdt/plugin -- "/path/to/test vault"
```

플러그인 ID는 `crdt-sync`이며 `<vault>/.obsidian/plugins/crdt-sync/`에 설치됩니다.
설치 후 Obsidian에서 커뮤니티 플러그인 → CRDT Sync를 켜고 설정에서 서버 주소, 볼트 ID, 토큰을 입력합니다.
토큰은 Obsidian 비밀 저장소에 보관되며 `data.json`에는 들어가지 않습니다.

명령 팔레트에서 쓸 수 있는 명령:

- **다시 연결**: 세션을 다시 시작합니다.
- **동기화 일시정지 / 동기화 재개**: 동기화를 잠시 멈추거나 다시 시작합니다.
- **삭제 확인 창 다시 열기**: 대량 삭제 확인 창을 닫았을 때 다시 엽니다 (상태 표시줄 클릭으로도 열 수 있습니다).

## 운영 가이드 (스펙 §8)

- 플러그인을 쓰는 모든 기기에서 **Obsidian Git의 auto-pull을 끈다.**
- git 커밋과 push는 **커밋 기기 한 대**에서만 한다.
- git 충돌이 나면 **작업 트리(CRDT) 버전을 우선**한다.
- 2MB가 넘는 `.md`, `.obsidian/`, `.trash/`, `.git/`은 동기화하지 않는다. 첨부파일(이미지, PDF)은 아직 동기화하지 않는다.
- 한꺼번에 많은 파일이 지워지면 동기화가 멈추고 확인 창이 뜬다.
- Windows가 담을 수 없는 이름(`\`나 `:`가 든 이름, `Misc./`처럼 점이나 공백으로 끝나는 폴더·파일 이름)도 다른 기기(macOS, Linux, Android, quilleaf)끼리는 그대로 동기화한다. **Windows 기기만** 그 노트를 디스크에 쓰지 않고, 노트마다 세션당 한 번 "작업 하나가 실패했습니다" 알림을 띄운다. 다른 노트의 동기화는 막히지 않고, 어느 기기에서도 그 노트가 지워지지 않는다. `\`가 든 이름은 모든 기기에서 쓰지 않는다 (Obsidian은 그런 이름을 만들지 않는다).
- 이미 동기화되던 노트를 다른 기기에서 그런 이름으로 바꾸면, Windows 기기에서는 옛 이름 그대로 남고 내용은 계속 동기화된다. 그 파일은 같은 노트이므로 Windows에서 지우면 모든 기기에서 지워진다 (다른 기기에서는 `.trash`로 간다).
