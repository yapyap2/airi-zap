# 멀티 클라이언트 연속 대화 + 기억 아키텍처 설계안

## 1) 목표 (Product-level)

AIRI를 "어디서 접속해도 같은 대화가 이어지는 AI 컴패니언"으로 만들기 위한 시스템 목표:

1. **Cross-client continuity**: Web / Desktop / Mobile 어느 클라이언트에서 접속해도 같은 세션과 최근 맥락을 바로 이어받는다.
2. **Short-term continuity**: 현재 대화의 주제/의도/진행 상태를 안정적으로 유지한다.
3. **Long-term memory**: 사용자 관련 사실/선호/장기 목표를 기억하고 필요 시 RAG로 재활용한다.
4. **Conflict safety**: 동시 접속, 오프라인 복귀, 재연결 상황에서 정합성을 유지한다.

---

## 2) 아키텍처 원칙

### 원칙 A. 저장소 역할 분리

- **Server DB = Source of Truth (정본)**
  - 멀티디바이스 연속성은 서버 정본 없이는 성립하기 어렵다.
- **Client Local Storage = Cache + Offline Buffer**
  - 빠른 UX와 오프라인 대응을 위해 로컬 우선 반영은 유지한다.

### 원칙 B. 통신 채널 역할 분리

- **HTTP API 채널**: 영속 데이터 동기화, 조회, 복원.
- **WebSocket 채널**: 실시간 이벤트 브로드캐스트 (typing, context update, generation progress 등).

### 원칙 C. 기억 계층 분리

- **Short-term context**: 턴 단위/세션 단위 대화 맥락.
- **Long-term memory**: 사용자 사실/선호/프로젝트/약속 등 시간이 지나도 유지되는 기억.

---

## 3) 모듈 구성 (논리 아키텍처)

### 3.1 Client Runtime (web/app 공통)

- UI 상태 관리 및 입력/출력 렌더링.
- 로컬 캐시에 즉시 반영(optimistic update).
- 서버와 양방향 sync 수행:
  - Push: 로컬 변경 업로드
  - Pull: 신규 디바이스 진입/재연결 시 복원

### 3.2 Session API (Server)

- 채팅 세션/메시지의 정본 저장과 조회 제공.
- 최소 기능:
  - 세션 목록 조회
  - 세션 상세/메시지 페이지네이션 조회
  - 세션 업서트(sync)
  - 삭제/복구(tombstone) 처리

### 3.3 Realtime Event Bus (Server Runtime + SDK)

- 연결/인증/재연결/heartbeat 처리.
- 클라이언트 또는 플러그인의 상태/문맥 업데이트를 실시간 전파.
- 데이터 영속 자체는 API/DB가 담당하고, 이벤트 버스는 "알림/전파" 역할로 제한.

### 3.4 Memory Pipeline

- **Extractor**: 메시지 스트림에서 기억 후보 추출.
- **Memory Store**: 구조화 메모리 저장 (사실/선호/목표/금지사항 등).
- **Embedding Index**: 벡터 인덱싱(예: pgvector).
- **Retriever**: 질의 시 관련 기억 검색 + 재랭킹.
- **Prompt Assembler**: short-term + long-term을 합쳐 모델 컨텍스트 구성.

---

## 4) 데이터 생명주기 (E2E)

### 단계 1. 대화 발생

사용자 입력이 클라이언트에 들어오면:

1. 로컬 세션에 즉시 반영
2. 모델 응답 생성 진행 상태를 UI에 스트리밍
3. 일정 주기 또는 이벤트 기반으로 서버 sync

### 단계 2. 서버 정본 반영

서버는 세션/메시지를 idempotent upsert 처리하고 updatedAt을 갱신한다.

### 단계 3. 메모리 추출

백그라운드 워커가 신규 메시지를 분석해:

- 장기 보존 가치가 있는 정보만 추출
- 신뢰도(confidence), 출처(provenance), TTL을 함께 저장

### 단계 4. 응답 시 RAG

새 응답 생성 전:

1. 최근 대화 window 로드
2. 세션 요약/상태 로드 (short-term)
3. 장기 기억 검색 (long-term)
4. 우선순위/충돌 정책으로 병합
5. 최종 프롬프트로 LLM 호출

---

## 5) 동기화 모델

### 5.1 부트스트랩(신규 디바이스 접속)

1. 인증 완료
2. 서버에서 세션 목록 메타 pull
3. 로컬 메타와 reconcile
4. active session + 최근 세션부터 lazy hydration

### 5.2 실시간 운용

- 쓰기: 로컬 선반영 후 서버 push
- 읽기: 주기적 delta pull + 이벤트 수신 시 선택적 pull

### 5.3 충돌 해결 정책

- 메시지 단위: idempotency key(message id) 기반 병합
- 메타 단위: 최신 updatedAt 우선 (LWW)
- 삭제: hard delete 대신 tombstone 우선

---

## 6) 기억 모델 제안

### 6.1 Memory Type

- **Profile**: 이름, 호칭, 말투 선호
- **Preference**: 좋아함/싫어함, 반복 패턴
- **Goal/Project**: 진행 중 목표, 작업 컨텍스트
- **Constraint**: 금지/주의 사항
- **Temporal**: 일정, 기념일, 약속

### 6.2 저장 스키마(논리)

- memory_id
- user_id
- memory_type
- content(structured JSON)
- confidence
- source_message_id
- valid_from / valid_to(TTL)
- created_at / updated_at

### 6.3 Retrieval 정책

재현율만 높이지 않고, 정확성까지 보장하기 위해 가중치 합산:

`final_score = semantic_similarity * w1 + recency * w2 + confidence * w3`

또한 오래된 사실과 최신 사실이 충돌할 때는 최신·고신뢰 항목 우선.

---

## 7) 신뢰성/운영 설계

### 7.1 오프라인/재연결

- Outbox queue로 전송 실패 이벤트 재시도.
- 재연결 시 handshake + delta sync 수행.

### 7.2 멱등성(idempotency)

- 모든 메시지/이벤트에 고유 ID 부여.
- 서버는 중복 수신 시 무해하게 처리.

### 7.3 관측성(observability)

- 필수 메트릭:
  - sync latency
  - sync fail rate
  - memory extraction precision
  - retrieval hit rate
  - cross-device restore success rate

---

## 8) 단계별 도입 로드맵

### Phase 1 — 연속성 최소 완성 (필수)

- 서버 read API + 클라이언트 초기 pull/reconcile 추가
- 목표: "어느 기기에서든 같은 세션 이어보기" 달성

### Phase 2 — 정합성 강화

- delta sync, tombstone, 충돌 정책 고도화
- 목표: 동시 접속/오프라인 복귀 품질 안정화

### Phase 3 — 단기 기억 강화

- 세션 요약/상태 저장소 도입
- 응답 생성 시 short-term context 조립 정교화

### Phase 4 — 장기 기억 + RAG

- memory extraction + pgvector retrieval + prompt integration
- 목표: 개인화된 장기 대화 컴패니언 체감 완성

---

## 9) 완료 기준 (Definition of Done)

1. A 디바이스에서 대화 후 B 디바이스 로그인 시, 동일 세션이 자동 복원된다.
2. 동시 접속에서 메시지 중복/역순/유실 비율이 허용 범위 이하이다.
3. 장기 기억 항목이 실제 응답에 근거 있게 반영된다.
4. 잘못 저장된 기억에 대해 정정 이벤트를 통해 교정 가능하다.

---

## 10) 구현 시 주의사항

- 이벤트 버스에 영속 책임을 과도하게 싣지 않는다. (영속은 API/DB)
- "기억"은 많이 저장하는 것보다 **검증 가능한 기억만 저장**하는 쪽이 중요하다.
- 초기에는 recall보다 precision을 우선해 메모리 오염을 줄인다.
- 멀티클라이언트 완성의 첫 단추는 "push-only"가 아니라 "push + pull + reconcile"이다.
