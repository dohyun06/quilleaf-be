# 첨부파일(바이너리) 동기화 — 설계

- 작성일: 2026-11-23
- 상태: 서버와 `packages/shared` 구현됨 (이 레포). 클라이언트(quilleaf 앱 `src/features/serversync`)는 이 문서를 계약으로 삼아 구현한다.
- 기반: [2026-10-07 동기화 설계](2026-10-07-quilleaf-sync-design.md) §10의 "첨부파일 동기화"

---

## 1. Problem 1-Pager

**Context**
- 지금은 `.md`만 동기화한다. 노트 텍스트는 파일마다 Y.Doc, 볼트 인덱스 Y.Doc의 `files` 맵이 경로 ↔ fileId를 잇는다.
- 실제 볼트: 첨부 약 470개, 약 72 MB, 가장 큰 파일 14 MB. 이미지와 PDF가 휴대폰에 오지 않는다.

**Problem**
- 노트가 참조하는 이미지·PDF가 다른 기기에 없어 노트가 깨져 보인다.

**Goal**
- `.md`가 아닌 모든 파일(이미지, PDF, docx, json, js…)을 파일 통째로 동기화한다. 병합하지 않는다.
- 생성/수정/이름 변경/삭제를 노트처럼 인덱스로 전파하고, 삭제 검토(대량 삭제 일시정지)를 그대로 쓴다.
- 지금 배포된 앱(이 기능을 모르는 옛 클라이언트)이 새 항목 때문에 아무것도 지우거나 망가뜨리지 않는다.

**Non-Goals**
- 바이너리 병합, 차등 전송(delta), 부분 다운로드(Range), 썸네일
- 서버 측 가비지 컬렉션(§7) — 이번에는 모두 보관한다
- 볼트별 저장 용량 할당(quota), 종단간 암호화

**Constraints**
- 배포 구성 유지: compose 프로젝트 `deploy`, 볼륨 `deploy_sync-data`(`/app/data`), 기존 환경 변수 그대로. 새 환경 변수는 선택이며 기본값이 있다.
- Caddy는 `handle @sync`(`/sync`, `/sync/*`)로 `sync-server:1234`에 넘기며 **접두사를 떼지 않는다** (`infra/caddy/sites/portfolio.caddy`). 서버는 `/sync/blobs/...`를 받는다.
- 첨부 하나 최대 50 MiB. 휴대폰(Android) 메모리에 50 MiB를 여러 번 복사하지 않는다.

---

## 2. 결정과 비교

| # | 결정 | 고려한 선택지 | 이유 |
|---|---|---|---|
| A1 | 첨부 목록은 **인덱스 Y.Doc의 새 루트 맵 `attachments`** | `files` 맵에 `kind: "attachment"` 항목 추가 / 첨부용 별도 Y.Doc | 옛 클라이언트는 `files`만 연다(§8). `files`에 넣으면 옛 클라이언트의 같은 경로 충돌 해소(`planCollisionResolution`)가 첨부 경로까지 고쳐 쓴다. 별도 Y.Doc은 연결·영속화·부트스트랩 경로가 하나 더 생긴다. 같은 문서의 다른 루트 맵은 옛 클라이언트에 보이지 않으면서 같은 연결로 동기화된다. |
| A2 | 본문은 **서버의 내용 주소(sha256) 블롭 저장소 + HTTP** | 첨부도 Y.Doc(바이너리를 Y.Map에) / WebSocket 메시지 | Y.Doc에 넣으면 지운 버전까지 문서 기록에 영원히 남고 `MAX_WS_PAYLOAD_BYTES`(8 MiB)를 넘는다. HTTP는 스트리밍·재시도·멱등 PUT이 쉽다. |
| A3 | 버전 값은 **하나의 평범한 객체 `blob: {sha256, size, baseSha256}`** | `sha256`, `size`를 각각 필드로 | Y.Map은 키마다 따로 LWW라, 동시 수정에서 한 기기의 sha256과 다른 기기의 size가 섞일 수 있다. 한 값이면 원자적으로 바뀐다. |
| A4 | 동시 수정은 **인덱스 LWW, 진 쪽 내용은 충돌 사본** | 서버가 버전 검사(If-Match) | 인덱스는 이미 CRDT라 서버가 끼어들 자리가 없다. 진 쪽은 `baseSha256`으로 자기 쓰기가 덮였는지 안다(§5.6). |
| A5 | 서버 GC **안 함** | 유예 기간 뒤 참조 없는 블롭 삭제 | 서버가 인덱스 Y.Doc을 해석해야 하고, 오프라인 큐(업로드는 됐는데 인덱스는 아직)와 경합한다. 데이터 손실 위험에 비해 디스크 절약이 작다(§7). |

---

## 3. 인덱스 항목 (wire format)

인덱스 문서 `<vaultId>/index`에 루트 맵이 하나 늘어난다.

```
files:       Y.Map<fileId, Y.Map{...}>          // 기존 그대로 (노트)
attachments: Y.Map<attachmentId, Y.Map{         // 새로 추가 (INDEX_ATTACHMENTS_MAP_KEY)
  path:      string        // 볼트 기준 상대 경로, '/' 구분. 유니코드 정규화 안 함 (노트와 같음)
  deleted:   boolean
  createdAt: number        // UTC epoch ms, 항목을 처음 만든 시각
  blob:      { sha256: string, size: number, baseSha256: string | null }   // 평범한 JSON 값 (Y.Map 아님)
}>
```

- `attachmentId`: UUID v4 (`isValidFileId`로 검사). 첨부는 Y.Doc이 없으므로 문서 이름으로 쓰이지 않는다.
- `blob.sha256`: 내용의 SHA-256, 소문자 hex 64자. `blob.size`: 바이트 수, `0..MAX_ATTACHMENT_BYTES`.
- `blob.baseSha256`: 이 버전을 쓴 기기가 덮어쓴 버전의 sha256. 새 파일이면 `null`.
- 필드 단위 Y.Map이라 이름 변경(`path`)·삭제(`deleted`)·수정(`blob`)이 동시에 일어나도 서로 덮지 않는다.
- 다른 기기에서 온 항목은 반드시 `parseAttachmentEntry(id, entryYMap.toJSON())`로 검증한다. `null`이면 그 항목은 없는 것처럼 무시한다(지우지도 고치지도 않는다).
- 쓰기 규칙: 항목을 만들 때는 한 트랜잭션에서 네 필드를 모두 쓴다. 수정은 `blob`만, 이름 변경은 `path`만, 삭제는 `deleted = true`만 쓴다. 블롭 업로드가 **성공한 뒤에만** `blob`을 쓴다(§5.3).

---

## 4. HTTP API

| 메서드 | 경로 | 성공 | 의미 |
|---|---|---|---|
| `HEAD` | `[prefix]/blobs/<vaultId>/<sha256>` | 200 + `Content-Length` | 있는지 확인 |
| `GET` | 같음 | 200, `application/octet-stream`, `Content-Length` | 내려받기 |
| `PUT` | 같음 (본문 = 파일 바이트) | 201 새로 저장 / 200 이미 있음 | 올리기 (멱등) |

- **URL**: `buildBlobUrl(serverUrl, vaultId, sha256)` — 사용자가 넣은 WebSocket 주소의 scheme만 `wss→https`, `ws→http`로 바꾸고 경로 뒤에 `/blobs/<vaultId>/<sha256>`을 붙인다. 예: `wss://dohyun06.is-a.dev/sync` → `https://dohyun06.is-a.dev/sync/blobs/my-vault-01/<sha>`. 쿼리와 fragment는 버린다. 서버는 `parseBlobRoute`로 경로 끝의 `blobs/<vaultId>/<sha256>`만 보므로 접두사가 있든(Caddy) 없든(로컬) 같다.
- **인증**: `Authorization: Bearer <token>` — WebSocket과 같은 볼트 토큰, 같은 `TokenStore.resolveVaultId`.
- **상태 코드**

| 코드 | 언제 | 클라이언트 동작 |
|---|---|---|
| 401 (+`WWW-Authenticate: Bearer`) | 헤더 없음, 형식 오류, 모르는/폐기된 토큰 | 동기화 인증 실패와 같게: 알림, 재시도 중지 |
| 403 | 토큰의 볼트 ≠ 경로의 볼트 | 설정 오류로 알림, 재시도 중지 |
| 404 | `HEAD`/`GET`에 블롭 없음 | HEAD면 PUT으로 올린다. GET이면 §5.4대로 재시도하고 한 번 알린다 |
| 405 (+`Allow: GET, HEAD, PUT`) | 다른 메서드 | 버그 |
| 411 | `PUT`에 `Content-Length` 없음 (chunked) | 버그 — 항상 길이를 보낸다 |
| 413 | `Content-Length` > 50 MiB, 또는 본문이 한도를 넘음 | 올리지 않음 (§5.2에서 미리 걸러짐) |
| 422 | 본문의 sha256 ≠ 경로의 sha256 | 파일이 읽는 중에 바뀜: 다시 해시부터 |
| 500 | 서버 I/O 오류 | 지수 백오프 재시도 |

- 다른 경로는 Hocuspocus 기본 응답(200 "Welcome to Hocuspocus!")이 그대로다.
- 읽지 않은 요청 본문이 남은 응답(거절, 이미 있음)은 `Connection: close`로 끊는다. 50 MiB를 받아 버리지 않는다. 그래서 클라이언트는 **PUT 전에 HEAD**로 확인한다.
- 서버 HTTP 요청 시간 제한은 30분(`HTTP_REQUEST_TIMEOUT_MS`): 50 MiB를 약 30 KiB/s까지 받아 준다. Node 기본값 5분은 느린 휴대폰 회선에서 큰 파일을 끊는다.
- Caddy는 요청 본문 크기 제한을 두지 않는다(설정 없음). 서버가 한도를 지킨다.

---

## 5. 클라이언트 알고리즘

### 5.1 대상 (제외 규칙)
`isAttachmentPath(normalizeVaultPath(path))`가 참인 파일만 다룬다.
- `isSafeRelativePath`를 통과하고,
- `.md`가 아니고(대소문자 무시 — `.md`는 텍스트 동기화 몫. 2 MiB가 넘는 `.md`도 첨부로 보내지 않는다),
- 어떤 경로 조각도 `.`으로 시작하지 않고 — `.obsidian/`, `.git/`, `.trash/`, `.leaflet/`, `.DS_Store`, 원자적 쓰기 임시 파일 `.leaflet-*.tmp`, `.gitignore` 등이 모두 빠진다,
- 파일 이름이 `EXCLUDED_ATTACHMENT_FILE_NAMES`(`thumbs.db`, `desktop.ini`, 대소문자 무시)가 아니다.

**`.leaflet/`을 빼는 이유**: 앱의 기기별 상태와 캐시다 — `workspace.json`(열린 탭·배치), `graph.json`, `pomodoro.json`, `cache.db`(SQLite 캐시), `appearance.json`, `snippets/`, `sync.json`(git 동기화 설정). 기기마다 자주 바뀌어 LWW 충돌 사본이 쏟아지고, `cache.db`는 열린 채 덮어쓰면 깨진다. 노트 동기화도 이미 `.leaflet/`을 뺀다(앱 `serversync/main.ts:193`). 공유가 필요한 설정은 지금처럼 git으로 나눈다. 숨김 폴더 전체를 빼는 것은 앱 백엔드가 새 파일을 숨김 폴더에 만들지 않는 규칙(`src-tauri/src/state.rs` `in_dot_folder`)과도 맞는다.

크기: `isWithinAttachmentSizeLimit(size)`가 거짓이면(50 MiB 초과) 동기화하지 않고, 경로마다 한 번 `file-too-large` 알림을 띄운다. 항목도 만들지 않는다.

Windows에서 못 쓰는 이름(`isWindowsSafePath` 거짓)으로 온 항목은 노트와 같이 이 기기에서 쓰지 않고 남겨 둔다(항목을 지우지 않는다).

### 5.2 로컬 기록 (기기별)
IndexedDB에 새 스토어 `attachments`(DB 버전 1 → 2, 기존 `onupgradeneeded`가 없는 스토어를 만든다). 노트의 `records`와 섞지 않는다 — 노트의 `RecordStore.findIdByPath`가 첨부를 노트로 오인하지 않도록.

```
AttachmentRecord[attachmentId] = {
  path: string          // 이 기기 디스크의 경로
  sha256: string        // 디스크와 인덱스가 마지막으로 합의한 내용 (= base)
  size: number
  mtimeMs: number       // 그때의 수정 시각 — 해시 캐시 키
}
```
- 해시 캐시: 디스크의 `(size, mtimeMs)`가 기록과 같으면 해시를 다시 계산하지 않는다. 시작할 때 470개·72 MB를 매번 읽지 않기 위해서다.

### 5.3 로컬 생성/수정 → 업로드 → 인덱스
1. 이벤트(`create`/`modify`) 또는 시작 스캔에서 대상 파일을 만난다. `stat` → 기록과 `(size, mtimeMs)`가 같으면 끝.
2. 해시를 계산한다(Rust에서 스트리밍, §5.9). 기록의 `sha256`과 같으면 `mtimeMs`만 갱신하고 끝.
3. 업로드 큐에 넣는다: `HEAD` → 404면 `PUT`(파일을 스트리밍, `Content-Length` = size). 422면 1단계부터 다시.
4. 업로드가 끝나면 한 트랜잭션에서 인덱스를 쓴다.
   - 기록 없음(새 파일): 경로의 살아 있는 항목이 있고 이 기기에 기록이 없으면 그 항목을 **채택**한다(§5.5 부트스트랩). 없으면 `register`: 새 UUID, `{path, deleted:false, createdAt: now, blob:{sha256, size, baseSha256:null}}`.
   - 기록 있음: 현재 인덱스 `blob.sha256`이 기록의 `sha256`과 같으면 `blob = {sha256: 새것, size, baseSha256: 기록.sha256}`. 다르면 원격이 먼저 바꾼 것이다 → §5.6 충돌.
5. 기록을 `{path, sha256: 새것, size, mtimeMs}`로 갱신한다.

인덱스에 `blob`을 쓰기 전에 업로드가 끝나야 한다. 그래야 다른 기기가 인덱스를 보고 GET할 때 블롭이 있다.

### 5.4 원격 인덱스 변경 → 다운로드 → 원자적 쓰기
`attachments` 맵의 `observeDeep`(원격 origin만) → `INDEX_PASS_DEBOUNCE_MS` 뒤 첨부 패스. 순서는 노트와 같다: 같은 경로 충돌 해소 → 삭제 → 이동 → 생성/수정.
- **같은 경로 충돌**: 살아 있는 항목 둘 이상이 `foldPathCase(path)`가 같으면 `attachmentId`가 가장 작은 항목이 경로를 갖고, 나머지는 `buildAttachmentConflictPath({path, timestampMs: createdAt, sha256: blob.sha256})`로 옮긴다(결정적이라 모든 기기가 같은 값으로 수렴).
- **생성/수정**: 항목의 `blob.sha256` ≠ 기록의 `sha256`(또는 기록 없음)이면:
  1. 디스크 파일의 현재 해시를 확인한다. 기록이 있는데 디스크가 기록과 다르면(로컬에서 바뀜) §5.6.
  2. `GET`으로 임시 파일(같은 폴더의 `.leaflet-<random>.tmp` — 제외 규칙에 걸리고 git 변경 목록에서도 빠지는 이름)에 스트리밍하면서 sha256과 크기를 검사한다. 다르면 버리고 재시도.
  3. 쓰기 직전에 대상 파일이 여전히 기대한 상태(없음 또는 기록의 sha256)인지 확인하고 `rename`으로 바꿔 넣는다(compare-and-swap). 기대와 다르면 다음 패스로.
  4. 기록을 먼저 새 값으로 쓰고(그 결과 생기는 `modify` 이벤트가 "기록과 같음"으로 무시되도록), 실패하면 되돌린다 — 노트의 `createRecordAndFile`과 같은 순서.
  - 404는 올린 기기가 아직 업로드 중일 수 없다(§5.3의 순서) — 서버 데이터 손실이나 다른 서버이므로 재시도하되 `task-failed` 알림을 한 번 띄운다.
- **이동**: 기록의 `path` ≠ 항목의 `path`면 `rename` (노트의 `applyMoves`처럼 대상이 차 있으면 다음 패스, 맞바꾸기는 임시 이름).
- **삭제**: `deleted`면 기록을 지우고(먼저) 파일을 볼트 `.trash/`로 옮긴다(`VaultPort.trash`와 같은 처리). 복구 가능하다.

### 5.5 시작 스캔과 부트스트랩
인덱스가 서버와 처음 동기화된 뒤 실행한다(노트 스캔과 같은 큐, 노트 스캔 다음).
1. 디스크의 대상 파일 목록과 기록을 비교한다. 기록이 있는데 파일이 없으면 로컬 삭제(§5.7).
2. 기록이 있는 파일은 §5.3 1~2단계로 변경을 확인한다.
3. 기록이 없는 파일: 같은 경로(`foldPathCase` 비교)의 살아 있는 항목이 있으면 해시를 비교한다. 같으면 기록만 만든다(업로드 없음 — git clone으로 같은 파일을 가진 새 기기). 다르면 **서버가 이기고** 로컬 내용은 충돌 사본으로 등록한 뒤 서버 내용을 내려받는다(노트 부트스트랩 §4.5와 같은 원칙). 항목이 없으면 새 파일로 등록한다(§5.3).
4. 그 다음 §5.4 패스를 한 번 돈다(인덱스에만 있는 파일을 내려받는다).

### 5.6 충돌 (같은 첨부를 동시에 수정)
인덱스는 LWW다. 진 쪽 내용만 잃지 않으면 된다.
- **로컬이 바뀌었는데 인덱스도 기록 이후 바뀜**(오프라인 수정 등, §5.3 4단계·§5.4 1단계): 로컬 내용(sha L)을 업로드하고 새 항목으로 `buildAttachmentConflictPath({path, timestampMs: now, sha256: L})` 경로에 등록한 뒤 파일을 그 이름으로 옮긴다. 원래 경로에는 인덱스 내용을 내려받는다.
- **내 쓰기가 동시 쓰기에 덮임**: 내가 `blob = L`(base B)을 썼는데, 원격 변경으로 항목이 `R`이 되었고 `R.baseSha256 ≠ L`이면 R은 L을 보지 못하고 쓴 것이다. 디스크가 아직 L(기록 = L)이면 L을 충돌 사본으로 등록하고(블롭은 이미 서버에 있다 — 업로드 생략) 원래 경로에 R을 내려받는다. `R.baseSha256 == L`이면 L 위의 정상 수정이므로 그냥 내려받는다.
- 이긴 기기는 아무것도 하지 않는다. 그래서 충돌 사본은 정확히 하나 생긴다.
- 이름 날짜는 UTC다. 사본 이름이 이미 있으면 노트의 `withCounter`처럼 ` 2`, ` 3`을 붙인다.

### 5.7 삭제와 이름 변경
- **로컬 삭제**: 노트의 `handleDelete`와 같이 `RENAME_PAIR_WINDOW_MS` 동안 보류한다. 그 사이에 **같은 sha256**의 파일이 생기면 이름 변경이다(해시가 같으면 내용이 같으므로 노트의 텍스트 비교보다 확실하다. 단, 같은 내용의 파일이 여럿이면 같은 파일 이름 → 가장 오래된 순으로 고른다). 짝이 없으면 `deleted = true`.
- **대량 삭제 검토**: 첨부 삭제도 노트와 **같은** `MassDeleteGuard`에 센다(`MASS_DELETE_THRESHOLD` = 10개/10초). 일시정지 목록에 첨부 경로도 보인다. 취소(복원)하면 서버 블롭을 내려받아 되살린다.
- **로컬 이름 변경 이벤트**(`rename`): 기록이 있으면 `path`만 바꾼다. 새 이름이 대상이 아니면(`.md`로 바꿈, 숨김 폴더로 옮김) 삭제로 처리한다.
- **원격 삭제와 로컬 수정이 겹침**: 삭제가 이긴다. 로컬 파일은 `.trash/`로 가므로 잃지 않는다 (노트와 같음).

### 5.8 재시도와 오프라인 큐
- 업로드와 다운로드 큐는 기기별로 하나씩, 동시 2개. 항목: `{attachmentId 또는 path, sha256}`. 같은 키가 다시 들어오면 앞의 것을 대체한다.
- 업로드 큐는 IndexedDB(`attachments` 스토어의 플래그 또는 별도 키)에 남겨, 앱을 다시 켜도 이어 간다. 꺼진 동안의 일은 시작 스캔이 어차피 다시 찾으므로 큐 영속화는 최적화일 뿐 정확성 조건이 아니다.
- 실패: 네트워크 오류·5xx·404(GET)는 지수 백오프(1s부터 최대 `RECONNECT_MAX_DELAY_MS` = 30s), 401/403은 중지하고 알림, 413은 포기, 422는 해시부터 다시.
- 오프라인: 인덱스 변경은 Yjs가 쌓았다가 보낸다. 다만 **업로드 전에는 `blob`을 쓰지 않으므로**, 오프라인에서 수정한 첨부는 재접속 후 업로드가 끝나야 인덱스에 나타난다.

### 5.9 Android와 큰 파일
- 바이트는 웹뷰로 넘기지 않는다. 해시·업로드·다운로드는 Rust에서 스트리밍한다(Cargo에 이미 `reqwest`가 있다. 해시는 `sha2` crate를 더한다). 50 MiB 파일을 IPC로 옮기면 base64/배열 복사로 메모리가 몇 배가 된다.
- 다운로드는 볼트 안 같은 폴더의 임시 파일에 쓰고 `rename`한다(같은 파일 시스템이라 원자적). Android 앱 저장소(볼트가 앱 데이터 폴더 아래)에서도 같다. 임시 파일은 시작할 때 `.leaflet-*.tmp`를 지운다.
- 토큰은 Rust가 이미 가진다(`serversync.rs`의 `token_store`). 웹뷰는 URL과 sha256만 넘긴다.

---

## 6. 공유 코드 (`@quilleaf/shared`) — 서버와 앱이 같은 값을 쓴다

이 레포 `packages/shared/src`에 구현되어 있다. 앱의 `src/features/serversync/shared/`에 같은 내용을 복사한다.

| 심볼 | 파일 | 내용 |
|---|---|---|
| `INDEX_ATTACHMENTS_MAP_KEY` = `"attachments"` | `constants.ts` | 인덱스 Y.Doc의 첨부 루트 맵 |
| `MAX_ATTACHMENT_BYTES` = 50 MiB | `constants.ts` | 첨부 하나 상한 |
| `BLOB_ROUTE_SEGMENT` = `"blobs"` | `constants.ts` | HTTP 경로 조각 |
| `EXCLUDED_ATTACHMENT_FILE_NAMES` | `constants.ts` | `thumbs.db`, `desktop.ini` |
| `isAttachmentPath(path)` | `attachment.ts` | §5.1 |
| `isWithinAttachmentSizeLimit(size)` | `attachment.ts` | 0 ≤ 정수 ≤ 50 MiB |
| `isSha256Hex(value)`, `sha256Hex(bytes)` | `attachment.ts` | 소문자 hex 64자, WebCrypto 해시 (테스트·작은 파일용. 큰 파일은 Rust) |
| `AttachmentEntry`, `AttachmentBlob` | `attachment.ts` | §3 타입 |
| `parseAttachmentEntry(id, raw)` | `attachment.ts` | 원격 항목 검증 (`raw` = 항목 Y.Map의 `toJSON()`) |
| `buildAttachmentConflictPath({path, timestampMs, sha256})` | `attachment.ts` | `photo (conflict 2026-11-23 abcdef).png` |
| `buildBlobUrl(serverUrl, vaultId, sha256)`, `parseBlobRoute(pathname)`, `BlobRoute` | `blobUrl.ts` | §4 |

**앱에 더할 모듈 (제안 이름)**
- `core/attachmentIndex.ts` — `VaultIndex`처럼 `attachments` 맵 래퍼: `register`, `get`, `entries`(정렬·검증), `findLiveByPath`, `setBlob`, `rename`, `markDeleted`, `planCollisionResolution`, `onRemoteChange`. origin은 `INDEX_LOCAL_ORIGIN`을 같이 쓴다.
- `core/attachmentRecords.ts` — §5.2 기록 (`attachments` IDB 스토어, `DB_VERSION` 2).
- `core/attachmentSync.ts` — §5.3~5.7: 로컬 이벤트 처리, 원격 패스, 충돌, 시작 스캔. `isAttachmentPath`로 노트 엔진과 이벤트를 나눈다.
- `core/blobTransfer.ts` — 업로드/다운로드 큐와 재시도(§5.8). 포트 `BlobPort { hashFile(path), stat(path), upload(url, path, sha256, size), download(url, sha256, size, path, expectedSha256 | null) }`.
- `leaflet/blobAdapter.ts` + Rust 명령(`src-tauri`): `attachment_stat`, `attachment_hash`, `blob_upload`, `blob_download`(임시 파일 + 해시 검사 + CAS rename). 경로는 기존 `resolve`/`validate` 경계를 통과시킨다.
- `syncEngine.ts`/`engineWiring.ts` — 첨부 패스를 노트 패스와 같은 큐에 걸고, 같은 `MassDeleteGuard`를 넘긴다.

---

## 7. 서버 저장소와 GC

- 위치: `BLOB_DIR`(선택 환경 변수), 기본값은 DB 옆 `blobs/` → 배포에서는 `/app/data/blobs/<vaultId>/<sha256>`. 같은 `deploy_sync-data` 볼륨이라 compose 변경이 없다.
- 쓰기: 같은 폴더의 `<sha256>.<uuid>.tmp`에 스트리밍하며 해시 → 일치하면 `rename`. 읽는 쪽은 반쯤 쓴 블롭을 보지 못한다. 같은 블롭의 동시 업로드는 각자 임시 파일을 쓰고 같은 바이트로 rename한다.
- 내용 주소라 같은 파일은 한 번만 저장된다(다른 경로, 다른 기기).
- **GC 결정: 하지 않는다.** 블롭은 지우지 않는다.
  - 이유: 서버가 "참조 없음"을 알려면 인덱스 Y.Doc을 풀어야 하고, 업로드 후 인덱스 갱신 전(§5.3), 오프라인 기기의 충돌 사본 등록 전(§5.6 — 블롭은 이미 있다고 가정) 블롭을 지우면 복구할 수 없다. 삭제한 첨부를 `.trash/`에서 되살릴 때도 블롭이 필요할 수 있다.
  - 디스크: 지금 72 MB + 수정·삭제된 옛 버전. 첨부는 거의 바뀌지 않으므로 수백 MB 수준으로 본다. VM 볼륨(수십 GB)에 비해 작다.
  - 나중에 필요하면: 오프라인 관리 명령(`token` CLI처럼)으로 인덱스에 없고 N일(예: 30일) 넘게 수정되지 않은 블롭을 지운다.
- 백업: `deploy/README.md` §4에 블롭 폴더 복사를 더했다.

---

## 8. 옛 클라이언트 안전성

옛 클라이언트 = `attachments` 맵을 모르는 지금 배포된 앱. 근거(앱 레포 `src/features/serversync`, 커밋 `781e8ac` 기준):
1. 인덱스에서 `files` 맵만 연다: `core/vaultIndex.ts:36` `doc.getMap(INDEX_FILES_MAP_KEY)`. 원격 변경 감시도 그 맵만 본다(`:109` `this.files.observeDeep`). `attachments` 맵의 변경은 옛 클라이언트의 인덱스 패스를 일으키지도 않는다.
2. Yjs는 열지 않은 루트 타입도 문서 상태에 그대로 보관하고 다시 보낸다(구조체는 타입을 열었는지와 무관하게 통합·인코딩된다). `packages/server/test/attachmentIndexCompat.test.ts`가 `files`만 여는 문서를 거쳐도 `attachments` 항목이 남는지 확인한다. 서버(`DocumentStore`)도 상태를 통째로 저장한다. 옛 클라이언트가 `attachments`를 지우거나 덮어쓸 수 없다 — 쓸 API 호출이 없다.
3. 디스크의 첨부 파일에도 손대지 않는다. 대상 판정이 `isSyncablePath`(`.md`만, `shared/path.ts:41`)이고:
   - 시작 스캔은 대상만 나열한다: `core/startupScan.ts:26-27`.
   - 로컬 생성/수정/이름 변경: `core/localChanges.ts:41`, `:66`, `:76-78` — 대상이 아니면 무시(`parkIfMoved`는 `keepsEntry`가 참일 때만이고, `engineWiring.ts:67`의 `keepsEntry`도 `.md`만 참).
   - 인덱스 적용: `core/indexApplier.ts:84`, `:132` — 대상이 아닌 경로는 이동·생성하지 않는다. 삭제(`:59-64`)는 이 기기 기록이 있는 항목만 — 첨부는 `files`에 없으므로 기록이 생기지 않는다.
4. 같은 경로 충돌 해소(`vaultIndex.ts:83-97`)는 `files` 항목끼리만 비교한다. 첨부는 `.md`가 아니므로 노트와 경로가 겹칠 수 없다.

결론: 새 항목을 별도 루트 맵에 두면 옛 클라이언트는 그것을 보지도, 지우지도, 그 파일을 건드리지도 않는다. 옛 앱만 쓰는 기기에는 첨부가 오지 않을 뿐이다. 반대로 `files`에 넣었다면 4번이 첨부 경로를 고쳐 쓸 수 있었다(A1).

새 클라이언트도 노트 엔진은 그대로다: 첨부 경로는 `isSyncablePath`가 거짓이라 노트 엔진이 무시하고, 첨부 엔진만 `isAttachmentPath`로 받는다. 두 판정은 겹치지 않는다(`.md` 여부).

---

## 9. 보안

- **경로 조작 불가**: 서버 저장 경로는 `<root>/<vaultId>/<sha256>`뿐이다. 두 값 모두 정규식 검증(`[a-z0-9-]{8,64}`, `[0-9a-f]{64}`) 후에만 경로가 된다(`BlobStore.pathFor`). 사용자 파일 이름은 서버에 가지 않는다.
- **볼트 격리**: 토큰이 가리키는 vaultId와 경로의 vaultId가 같아야 한다(403). 같은 내용이라도 볼트마다 따로 저장해, 남의 볼트에 어떤 파일이 있는지 해시로 떠볼 수 없다.
- **인증**: WebSocket과 같은 토큰. 로그에 토큰과 파일 내용을 남기지 않는다(`blob.stored`는 vaultId, sha256, 크기만).
- **무결성**: 서버는 저장 전에, 클라이언트는 쓰기 전에 sha256을 확인한다. 서버가 잘못된 바이트를 주어도 디스크에 쓰지 않는다.
- **크기·남용**: 50 MiB 상한을 `Content-Length`로 미리, 스트림에서 다시 확인한다. 길이 없는 업로드는 411. 할당량과 요청 빈도 제한은 없다 — 토큰을 가진 사람은 볼트 주인뿐이라는 1단계 가정(개인용)이다. 토큰이 새면 폐기(`token revoke`)한다. 디스크가 차는 위험은 남는다 → 다중 사용자 단계에서 볼트별 할당량을 둔다.
- **클라이언트 쓰기 경계**: 원격 항목 경로는 `parseAttachmentEntry`(안전한 상대 경로, 숨김 폴더 아님) + 앱 Rust의 기존 `validate`/`resolve`(심볼릭 링크로 볼트 밖 금지)를 모두 통과해야 쓴다.

---

## 10. 테스트 계획

**이 레포 (구현됨)**
- `packages/shared/test/attachment.test.ts`: 제외 규칙(숨김 폴더·파일, `.md` 대소문자, OS 메타 파일, 위험 경로), 크기 경계(정확히 50 MiB, +1, 음수, 소수), sha256 벡터, 항목 검증 실패 사례, 충돌 이름(UTC, 확장자, 확장자 없음, 점 있는 폴더).
- `packages/shared/test/blobUrl.test.ts`: `wss`/`ws` 변환, 끝 `/`, 쿼리 제거, 잘못된 입력, `/sync` 접두사 유무, 왕복, 경로 조작 문자열.
- `packages/server/test/blobStore.test.ts`: 저장/읽기, 멱등, 해시 불일치·크기 초과 시 임시 파일 없음, 볼트 격리, 잘못된 이름 거부.
- `packages/server/test/attachmentIndexCompat.test.ts`: `files`만 여는(옛) 클라이언트를 거쳐도 `attachments` 항목이 남는다.
- `packages/server/test/blobRoutes.test.ts`(실제 서버, 임의 포트): HEAD 404 → PUT 201 → HEAD/GET → PUT 200, 접두사 없는 경로, 401(없음/모름/형식)·403, 422, 413(본문 읽기 전), 411, 405, 다른 경로는 Hocuspocus 응답, 로그에 토큰 없음.

**앱 (구현할 것)**
- 단위: `attachmentIndex`(검증·정렬·충돌 계획), 해시 캐시(`size`/`mtime`), 이름 변경 짝짓기(같은 sha256), 충돌 두 경우(§5.6)에서 사본이 정확히 하나.
- 회귀(먼저 실패하게):
  1. 옛 클라이언트 안전성: `attachments` 항목이 있는 인덱스로 옛 엔진(`VaultIndex`/`IndexApplier`/`StartupScan`)을 돌려도 디스크의 첨부와 `attachments` 맵이 그대로다.
  2. git clone으로 같은 첨부를 가진 새 기기가 부트스트랩해도 업로드·충돌 사본이 생기지 않는다.
  3. 다운로드가 중간에 끊겨도 대상 파일이 반쯤 쓰이지 않는다.
  4. 인덱스에 `blob`이 보이면 서버에 블롭이 있다(업로드 → 인덱스 순서).
- 수렴: FakeVault 기기 여러 대 + 메모리 블롭 서버로 무작위 생성·수정·이름 변경·삭제·오프라인 후 모든 기기의 디스크(경로 → sha256)가 같다.
- 통합: 이 레포 서버를 테스트에서 띄워 실제 PUT/GET(`packages/server/test/blobRoutes.test.ts`와 같은 방식).
- 수동: 데스크톱에서 이미지 붙여넣기 → 휴대폰에 표시, 휴대폰에서 찍은 사진 → 데스크톱, 14 MB PDF, 비행기 모드 수정 후 복귀, 두 기기 동시 수정 → 충돌 사본 하나.

---

## 11. 가정

- B1. 첨부는 드물게 바뀐다(대부분 한 번 쓰고 끝). 그래서 GC 없이도 디스크 사용이 완만하다.
- B2. 앱 백엔드의 파일 목록(`list_files`)과 `vault:fs` 이벤트가 `.md`가 아닌 파일도 내보낸다 — 앱 구현 때 확인한다. 아니면 첨부용 목록 명령을 더한다.
- B3. 사용자가 넣는 서버 주소는 `wss://호스트[/경로]` 형태다. 블롭 URL은 그 경로 아래에 생긴다.
