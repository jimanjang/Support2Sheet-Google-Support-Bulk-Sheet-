
# Support2Sheet (Google Support Bulk → Sheet)

Google Support 문서(Topic/Answer)를 재귀적으로 크롤링해서 Google Sheets에 축적하는 Apps Script입니다.
Topic 페이지에서 Answer 링크와 하위 Topic 링크를 모두 수집하고, Queue 기반으로 단계별 크롤링을 진행합니다.
Answer 문서는 제목/링크/본문(텍스트) 형태로 `Articles` 시트에 Upsert 됩니다.

## Features

* **Topic 재귀 크롤링**

  * Topic 페이지에서 Answer + 하위 Topic 링크를 대량 추출
  * Queue에 넣어 BFS처럼 단계별 확장
* **Answer Upsert 저장**

  * Answer 페이지를 파싱해 텍스트로 정규화
  * `guid`(url+text MD5) 기준으로 중복 방지 / 업데이트
* **Queue 기반 단계 실행**

  * 한 번에 N개씩만 처리하는 **Crawl step** 제공
  * 대량 문서도 안전하게 나눠 수집
* **자동 메뉴 생성**

  * Spreadsheet 열 때 `Support2Sheet` 메뉴 자동 생성

## Sheet 구조

스크립트는 아래 두 개의 시트를 사용합니다.

### 1) `Articles`

| column      | description               |
| ----------- | ------------------------- |
| title       | Answer 문서 제목              |
| link        | 정규화된 Support URL          |
| pubDate     | 수집 시각(UTC)                |
| description | Answer 본문 텍스트             |
| guid        | `md5(url + text)` 기반 고유 키 |

### 2) `Queue`

| column | description                        |
| ------ | ---------------------------------- |
| type   | `topic` 또는 `answer`                |
| url    | 처리할 URL                            |
| status | `pending` → `in-progress` → `done` |
| ts     | Queue에 들어간 시각                      |

## How it works

1. **Seed**

   * Topic URL을 받아 HTML에서 Answer/Topic 링크를 추출합니다.
   * 추출된 링크들을 `Queue` 시트에 `pending`으로 적재합니다.
   * 최초 Topic도 큐에 넣어 재귀 크롤링이 이어지도록 합니다.

2. **Crawl step**

   * Queue에서 `pending` 상태 N개를 꺼내 `in-progress`로 바꾼 뒤 처리합니다.
   * `topic`이면 → 하위 Answer/Topic을 다시 Queue에 넣습니다.
   * `answer`이면 → 페이지 파싱 후 `Articles`에 Upsert 합니다.
   * 처리 완료된 Queue row는 `done` 처리합니다.

> 대량 크롤링 시 Apps Script 시간 제한을 피하기 위해 step-by-step 실행 구조를 사용합니다.

## Setup

1. Google Sheets 생성
2. **Extensions → Apps Script**로 들어가서 새 프로젝트 생성
3. 이 레포의 스크립트를 그대로 붙여넣기
4. 저장 후 시트로 돌아가 새로고침하면 메뉴가 생성됩니다.

## Usage

### 1) Seed from topic URL

* 메뉴: **Support2Sheet → Seed from topic URL**
* Topic URL을 입력합니다. 예:

  * `https://support.google.com/a#topic=4388346`
  * `https://support.google.com/admin/topic/9652544?hl=ko`
* Queue에 links가 적재됩니다.

### 2) Crawl step

* 메뉴: **Support2Sheet → Crawl step (N items)**
* 한 번에 처리할 큐 아이템 수(N)를 입력합니다. (기본 20, 최대 100)
* 실행 결과로 처리된 answer/topic 수, 삽입/업데이트 수, 대기 큐가 표시됩니다.
* Queue가 빌 때까지 반복 실행하면 전체 수집이 완료됩니다.

## Configuration

코드 상단의 상수로 동작을 조정할 수 있습니다.

```js
const ARTICLES_SHEET = 'Articles';
const QUEUE_SHEET = 'Queue';
const DEFAULT_LANG = 'ko';
const VERSION = 'bulk-2025-11-03';
```

* **DEFAULT_LANG**

  * Support URL에 `hl=ko`처럼 언어 파라미터를 강제 설정합니다.
  * 필요 시 `en`, `ja` 등으로 변경 가능

## Notes / Limits

* Apps Script 실행 제한(시간/URLFetch quota)이 있으므로

  * **Crawl step을 여러 번 나눠 실행하는 방식**을 권장합니다.
* `Utilities.sleep(200)` 딜레이가 기본 포함되어 있어 과도한 요청을 방지합니다.

  * 더 빠르게 하고 싶으면 줄일 수 있지만, 서버 차단 위험이 있습니다.
* Support 페이지 구조가 바뀌면 파싱 로직(`parseAnswerPage`, `extractLinks_`) 수정이 필요할 수 있습니다.

## Troubleshooting

### Queue가 줄지 않아요

* `Queue` 시트에서 status가 `in-progress`로 남아있을 수 있습니다.
* 이런 경우 `pending` / `in-progress`를 모두 대상으로 다시 실행되도록 설계되어 있어

  * **Crawl step을 다시 실행하면 진행됩니다.**

### 제목/본문이 이상해요

* Support HTML 구조 변경 가능성
* `parseAnswerPage()`의 selector 정규식( `<article class="article-container">` 등) 수정 필요

### 같은 문서가 반복 저장돼요

* `guid = md5(url + text)` 기반이라

  * 본문 텍스트가 미세하게 달라지면 다른 guid로 들어올 수 있습니다.
* 완전 URL 기준 dedupe로 바꾸려면 `guid` 생성식을 `md5(url)`로 바꾸면 됩니다.

## Roadmap (optional)

* [ ] Error row 재시도 전략 개선 (`failed` 상태 추가)
* [ ] topic depth / domain scope 제한 옵션
* [ ] Crawl step 자동 반복 트리거(시간 기반)

## License

MIT License (원하면 다른 라이선스로 변경하세요)

---

원하시면

* 레포 이름/설명 톤,
* “Roadmap” 포함 여부,
* 한국어/영어 버전 분리,
* 실제 사용 예시 스크린샷/데모 GIF

까지 맞춰서 README 더 “완성형”으로 다듬어줄게요.
