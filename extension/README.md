# 캘린더 연차 자동 동기화 Chrome 확장

그룹웨어 페이지 방문 시 잔여 연차 정보를 자동으로 캘린더 Firebase로 동기화한다.
PC 작업 스케줄러와 달리 **PC가 꺼져 있어도 OK** — 회사에서 그룹웨어 보다가 자연스럽게 갱신됨.
팝업에는 "연차 동기화"(자동+수동) 버튼과 "출퇴근 동기화"(팀 전체, 수동 전용) 버튼이 있다.

## 사전 조건 (1회)

Firebase 보안 규칙에 쓰기 권한이 열려 있어야 한다. 아래 규칙이 `console.firebase.google.com` 의
`calendar-6df01` → Realtime Database → 규칙 에 게시되어 있는지 확인:

```json
"annual_leave": {
  ".read": "auth != null && (auth.token.email === 'miracle0938@gmail.com' || auth.token.email === 'miracle38@jiran.com')",
  ".write": "auth != null && (auth.token.email === 'miracle0938@gmail.com' || auth.token.email === 'miracle38@jiran.com')"
},
"attendance": {
  ".read": "auth != null && (auth.token.email === 'miracle0938@gmail.com' || auth.token.email === 'miracle38@jiran.com')",
  ".write": "auth != null && (auth.token.email === 'miracle0938@gmail.com' || auth.token.email === 'miracle38@jiran.com')"
},
"employee_info": {
  ".read": "auth != null && (auth.token.email === 'miracle0938@gmail.com' || auth.token.email === 'miracle38@jiran.com')",
  ".write": "auth != null && (auth.token.email === 'miracle0938@gmail.com' || auth.token.email === 'miracle38@jiran.com')"
}
```

저장소의 `database.rules.json` 파일에 이미 반영되어 있으나 Firebase Console에서 별도 게시 필요.

## 설치

1. Chrome 주소창에 `chrome://extensions` 입력
2. 우측 상단의 **개발자 모드** 토글 ON
3. 좌측 상단의 **압축해제된 확장 프로그램을 로드합니다** 클릭
4. `D:\00. Claude DEV\01. 캘린더\extension\` 폴더 선택
5. "캘린더 연차 자동 동기화" 가 목록에 뜨면 성공
6. (선택) 상단 도구모음 퍼즐 아이콘 → 핀 고정

## 첫 로그인

1. 도구모음에서 확장 아이콘 클릭
2. 캘린더와 동일한 **Firebase 이메일/비밀번호** 입력 (`miracle0938@gmail.com` 또는 `miracle38@jiran.com`)
3. 로그인되면 "지금 동기화" 버튼이 보임 — 한 번 눌러서 즉시 갱신 테스트

> Google 계정으로 캘린더에 로그인하는 경우, Firebase Console > Authentication > Users 에서
> 해당 이메일에 비밀번호를 별도 설정해야 한다 (또는 Firebase 비밀번호 재설정 메일 사용).

## 동작 방식

**연차 동기화**
- **자동 1**: 그룹웨어 페이지 (`https://jiran.groupware.pro/*`) 로드 완료 시 → 동기화 시도
- **자동 2**: 1시간마다 알람으로 동기화 시도 (브라우저 켜져 있을 때만)
- **스로틀**: 마지막 동기화 후 1시간 이내면 자동으로 skip (API 부하 방지)
- **수동**: 확장 팝업에서 "연차 동기화" 누르면 즉시 (스로틀 무시)

**출퇴근 동기화(팀 전체, 근태관리 패널용)**
- 자동 트리거 없음 — 확장 팝업의 "출퇴근 동기화" 버튼을 눌러야 실행됨 (수동 전용, 자체 1시간 스로틀)
- 이번 달 전체를 조회해 `/attendance/{yyyy-MM}`, `/employee_info`에 저장
- PC 예약 작업(`CalendarAttendanceSync`, 평일 밤 11시)이 같은 경로에 자동으로 채워주므로, 버튼은 "지금 바로 최신화하고 싶을 때"만 쓰면 됨

## 권한 설명

manifest.json 에 다음 권한이 있다:

| 권한 | 용도 |
|---|---|
| `alarms` | 1시간 주기 동기화 |
| `storage` | Firebase 인증 토큰 저장 (chrome.storage.local) |
| `notifications` | 동기화 결과 알림 |
| `jiran.groupware.pro/*` | 페이지 로드 이벤트 감지 |
| `jiran.api.groupware.pro/*` | annualsummary / employeeInfoList / commute API 호출 |
| `identitytoolkit.googleapis.com/*` | Firebase Auth 로그인 |
| `securetoken.googleapis.com/*` | 인증 토큰 갱신 |
| `calendar-6df01-default-rtdb.firebaseio.com/*` | RTDB 데이터 쓰기 |

비밀번호는 저장하지 않는다 (Firebase 토큰만 저장). 토큰은 1시간마다 자동 갱신됨.

## 동작 확인

- 확장 팝업: "최근 동기화: N분 전 / 6명" 표시
- 캘린더: 우측 📊 패널 하단 "🔄 연차 동기화: N분 전 ..." 표시
- 알림: 그룹웨어 페이지 들어가면 우측 하단에 "연차 동기화 완료 6명" 토스트

## 문제 해결

- 동기화 실패 "로그인 필요" → 토큰 만료. 팝업에서 다시 로그인
- 동기화 실패 "HTTP 401/403" → 그룹웨어 SSO 세션 만료. 그룹웨어 평소처럼 다시 로그인하면 다음 페이지 방문 시 자동 재시도
- 알람이 안 뜸 → 브라우저 알림 권한 확인 (Windows 알림 센터)
- 동기화는 되는데 캘린더에 안 보임 → 캘린더 페이지 강제 새로고침 (Ctrl+F5), 또는 캘린더 자체가 Firebase 룰의 읽기 권한 확인

## 기존 PC 작업 스케줄러와의 관계

둘 다 같은 Firebase 경로 (`/annual_leave/{year}`)에 쓰기 때문에 공존해도 충돌 없다.
- 확장 = 평소 자동
- PC 스케줄러 = PC 켜져 있을 때 백업
- 둘 다 실패하면 `sync.bat` 또는 `sync-debug.bat` 수동 실행

`/annual_leave/_meta.lastSyncSource` 필드로 어느 쪽이 마지막에 썼는지 확인 가능 ("extension" 또는 미설정=스크래퍼).
