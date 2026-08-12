// 공용 상수 + 함수 (background.js / popup.js 모두에서 사용)

const FIREBASE_API_KEY = 'AIzaSyDI5VxCwhP6RVtFcdvUBJnfpMvRiP7A0us';
const FIREBASE_DB_URL = 'https://calendar-6df01-default-rtdb.firebaseio.com';
// Chrome 확장은 관리자 계정만 사용 (연차 동기화는 쓰기 작업이라 viewer 제외)
const ALLOWED_EMAILS = ['miracle0938@gmail.com', 'miracle38@jiran.com'];

const GROUPWARE_ORG_ID = 165;          // 품질관리팀
const SYNC_THROTTLE_MS = 60 * 60 * 1000; // 1시간

function currentYear() {
    return new Date().getFullYear();
}

function annualSummaryUrl(year, orgId) {
    return 'https://jiran.api.groupware.pro/v1/hr/mss/employeeinfo/annualsummary'
        + '?currentYear=' + year
        + '&organizationId=' + orgId
        + '&pageNumber=1&limitNumber=100&searchType=ANNUAL';
}

// ===== Firebase Auth (REST) =====

async function signInWithPassword(email, password) {
    const res = await fetch(
        'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FIREBASE_API_KEY,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }) }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error && data.error.message || 'Login failed');
    if (ALLOWED_EMAILS.indexOf(data.email) === -1) {
        throw new Error('허용되지 않은 계정입니다: ' + data.email);
    }
    return {
        email: data.email,
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + (Number(data.expiresIn) - 30) * 1000, // -30s 여유
    };
}

async function refreshIdToken(refreshToken) {
    const res = await fetch(
        'https://securetoken.googleapis.com/v1/token?key=' + FIREBASE_API_KEY,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken) }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error && data.error.message || 'Refresh failed');
    return {
        idToken: data.id_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (Number(data.expires_in) - 30) * 1000,
    };
}

async function sendPasswordResetEmail(email) {
    const res = await fetch(
        'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + FIREBASE_API_KEY,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }) }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error && data.error.message || 'Failed');
}

async function getValidAuth() {
    const stored = await chrome.storage.local.get(['auth']);
    if (!stored.auth) return null;
    if (stored.auth.expiresAt > Date.now()) return stored.auth;
    try {
        const refreshed = await refreshIdToken(stored.auth.refreshToken);
        const merged = { ...stored.auth, ...refreshed };
        await chrome.storage.local.set({ auth: merged });
        return merged;
    } catch (e) {
        await chrome.storage.local.remove(['auth']);
        return null;
    }
}

// ===== 그룹웨어 API → 캘린더 Firebase 푸시 =====

// background.js 가 가로채 저장해 둔 그룹웨어 인증 헤더(Authorization 등)
async function getCapturedGwHeaders() {
    try {
        const { gwHeaders } = await chrome.storage.local.get(['gwHeaders']);
        return gwHeaders && typeof gwHeaders === 'object' && Object.keys(gwHeaders).length ? gwHeaders : null;
    } catch (_) { return null; }
}

// 가로챈 그룹웨어 인증 헤더를 폐기한다. 만료된 토큰을 계속 재사용해 401이 반복되지 않도록,
// 401/403을 만나면 즉시 버려서 다음 그룹웨어 화면 방문 때 새 토큰을 다시 캡처하게 한다.
async function clearCapturedGwHeaders() {
    try { await chrome.storage.local.remove(['gwHeaders', 'gwHeadersAt']); } catch (_) {}
}

// 그룹웨어 API 응답이 실패(!ok)일 때 표준 에러를 만든다.
// 401/403이면 낡은 캡처 토큰을 폐기하고, 사용자가 취할 조치를 담은 메시지를 붙인다.
async function makeGwApiError(res) {
    const authFail = res.status === 401 || res.status === 403;
    if (authFail) await clearCapturedGwHeaders(); // 만료 토큰 자가치유: 다음 방문 때 재캡처
    // 인증 실패면 응답 본문은 로그인 HTML(노이즈)이므로 버리고, 실행 가능한 안내만 남긴다.
    let detail = '';
    if (authFail) {
        detail = ' — 그룹웨어에 로그인 후 인사/근태(출퇴근) 화면을 한 번 열어 인증을 갱신한 뒤 다시 시도하세요';
    } else {
        try { const body = (await res.text()).slice(0, 200); if (body) detail = ' — ' + body; } catch (_) {}
    }
    const err = new Error('그룹웨어 API HTTP ' + res.status + detail);
    err.status = res.status;
    // 캡처 토큰이 없었거나(첫 사용) 방금 폐기했으므로, 인증 화면 방문이 필요함을 알린다.
    err.needsToken = authFail;
    return err;
}

async function fetchGroupwarePayload() {
    const url = annualSummaryUrl(currentYear(), GROUPWARE_ORG_ID);
    const headers = { 'Accept': 'application/json' };
    // 쿠키(credentials:include)만으로 부족한 경우를 대비해, 페이지가 실제로 쓰는 인증 헤더를 함께 실어 보낸다.
    const captured = await getCapturedGwHeaders();
    if (captured) Object.assign(headers, captured);

    const res = await fetch(url, { method: 'GET', credentials: 'include', headers });
    if (!res.ok) throw await makeGwApiError(res);
    const data = await res.json();
    if (!data || !data.success || !Array.isArray(data.payload)) {
        throw new Error('그룹웨어 응답 비정상');
    }
    return data.payload;
}

// ===== 그룹웨어 근태(출퇴근) → 일일 진행업무 앱 =====

function worktimesUrl(startYmd, endYmd) {
    return 'https://jiran.api.groupware.pro/v1/hr/commute/my/worktimes'
        + '?startYmd=' + startYmd + '&endYmd=' + endYmd;
}

// "2026-07-01T09:32:00" → "09:32", null/빈값 → ""
function isoToHm(v) {
    const m = String(v || '').match(/T(\d{2}):(\d{2})/);
    return m ? (m[1] + ':' + m[2]) : '';
}

// startYmd~endYmd 범위의 내 출퇴근을 [{date, clockIn, clockOut}] 로 반환
async function fetchWorktimes(startYmd, endYmd) {
    const headers = { 'Accept': 'application/json' };
    const captured = await getCapturedGwHeaders();
    if (captured) Object.assign(headers, captured);

    const res = await fetch(worktimesUrl(startYmd, endYmd), { method: 'GET', credentials: 'include', headers });
    if (!res.ok) throw await makeGwApiError(res);
    const data = await res.json();
    if (!data || !data.success || !Array.isArray(data.payload)) {
        throw new Error('그룹웨어 응답 비정상');
    }
    return data.payload
        .map((p) => ({ date: p.baseDate, clockIn: isoToHm(p.checkInTime), clockOut: isoToHm(p.checkOutTime) }))
        .filter((x) => x.date);
}

function transformPayload(payload, year) {
    const now = Date.now();
    const byName = {};
    for (const emp of payload) {
        const name = (emp.employeeName || '').trim();
        if (!name) continue;
        byName[name] = {
            employeeId: String(emp.employeeId || ''),
            name,
            yearNum: Number(emp.yearNum) || 0,
            totalUsedNum: Number(emp.totalUsedNum) || 0,
            remainNum: Number(emp.remainNum) || 0,
            organizationName: emp.organizationName || '',
            dutyName: emp.dutyName || '',
            hireYmd: emp.hireYmd || '',
            standardYear: emp.standardYear || String(year),
            startYmd: emp.startYmd || '',
            endYmd: emp.endYmd || '',
            updatedAt: now,
        };
    }
    return byName;
}

async function writeFirebase(year, byName, idToken) {
    const yearUrl = FIREBASE_DB_URL + '/annual_leave/' + year + '.json?auth=' + encodeURIComponent(idToken);
    const metaUrl = FIREBASE_DB_URL + '/annual_leave/_meta.json?auth=' + encodeURIComponent(idToken);

    const yearRes = await fetch(yearUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify(byName) });
    if (!yearRes.ok) {
        const t = await yearRes.text();
        throw new Error('Firebase write failed: ' + yearRes.status + ' ' + t);
    }
    const meta = {
        lastSyncAt: Date.now(),
        lastSyncYear: String(year),
        lastSyncCount: Object.keys(byName).length,
        lastSyncSource: 'extension',
    };
    await fetch(metaUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(meta) });
}

async function runSync({ force = false } = {}) {
    const auth = await getValidAuth();
    if (!auth) throw new Error('로그인 필요 — 확장 팝업에서 로그인하세요');

    if (!force) {
        const { lastSyncAt = 0 } = await chrome.storage.local.get(['lastSyncAt']);
        if (Date.now() - lastSyncAt < SYNC_THROTTLE_MS) {
            return { skipped: true, reason: 'throttled', nextEligibleAt: lastSyncAt + SYNC_THROTTLE_MS };
        }
    }

    const payload = await fetchGroupwarePayload();
    const year = currentYear();
    const byName = transformPayload(payload, year);
    await writeFirebase(year, byName, auth.idToken);

    const lastSyncAt = Date.now();
    await chrome.storage.local.set({ lastSyncAt, lastSyncCount: Object.keys(byName).length });
    return { skipped: false, count: Object.keys(byName).length, year };
}

// ===== 그룹웨어 팀 전체 출퇴근 → 캘린더 Firebase 푸시 (근태관리 팝업 전용, 별도 스로틀) =====

const ATTENDANCE_SYNC_THROTTLE_MS = 60 * 60 * 1000; // 1시간

function employeeInfoListUrl(orgId) {
    return 'https://jiran.api.groupware.pro/v1/hr/mss/employeeinfo/employeeInfoList'
        + '?organizationId=' + orgId + '&childOrganizationList=';
}

function teamWorktimesUrl(employeeIds, startYmd, endYmd) {
    return 'https://jiran.api.groupware.pro/v1/hr/commute/worktimes'
        + '?startYmd=' + startYmd + '&endYmd=' + endYmd + '&userIds=' + employeeIds.join(',');
}

// "PT8H30M" / "PT0S" 등 ISO8601 duration → 분
function isoDurationToMinutes(iso) {
    const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return 0;
    const h = Number(m[1] || 0), min = Number(m[2] || 0), s = Number(m[3] || 0);
    return h * 60 + min + Math.round(s / 60);
}

async function fetchEmployeeInfoList() {
    const url = employeeInfoListUrl(GROUPWARE_ORG_ID);
    const headers = { 'Accept': 'application/json' };
    const captured = await getCapturedGwHeaders();
    if (captured) Object.assign(headers, captured);

    const res = await fetch(url, { method: 'GET', credentials: 'include', headers });
    if (!res.ok) throw await makeGwApiError(res);
    const data = await res.json();
    if (!data || !data.success || !Array.isArray(data.payload)) {
        throw new Error('그룹웨어 응답 비정상');
    }
    return data.payload;
}

async function fetchTeamWorktimes(employeeIds, startYmd, endYmd) {
    const headers = { 'Accept': 'application/json' };
    const captured = await getCapturedGwHeaders();
    if (captured) Object.assign(headers, captured);

    const res = await fetch(teamWorktimesUrl(employeeIds, startYmd, endYmd), { method: 'GET', credentials: 'include', headers });
    if (!res.ok) throw await makeGwApiError(res);
    const data = await res.json();
    if (!data || !data.success || !Array.isArray(data.payload)) {
        throw new Error('그룹웨어 응답 비정상');
    }
    return data.payload;
}

function currentMonthKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthStartEndYmd() {
    const d = new Date();
    const y = d.getFullYear(), m = d.getMonth();
    const pad = (n) => String(n).padStart(2, '0');
    const startYmd = y + '-' + pad(m + 1) + '-01';
    const lastDay = new Date(y, m + 1, 0).getDate();
    const endYmd = y + '-' + pad(m + 1) + '-' + pad(lastDay);
    return { startYmd, endYmd };
}

// employeeInfoList → { idByName, infoByName } (infoByName: 입사일/총 재직기간/총 경력)
function transformEmployeeInfo(employeeList) {
    const idByName = {};
    const infoByName = {};
    for (const emp of employeeList) {
        const name = (emp.employeeName || '').trim();
        if (!name || emp.employeeId == null) continue;
        idByName[name] = emp.employeeId;
        infoByName[name] = {
            hireYmd: (emp.hireYmd || '').slice(0, 10),
            tenure: emp.groupHirePeriod || '',
            career: emp.careerTotalTerm || '',
        };
    }
    return { idByName, infoByName };
}

// worktimes payload → { ymd: { name: {clockIn, clockOut, late, recognizedMin, overtimeMin} } }
function transformAttendance(idByName, payload, startYmd, endYmd) {
    const nameById = {};
    for (const [name, id] of Object.entries(idByName)) nameById[id] = name;

    const byDate = {};
    for (const rec of payload) {
        const name = nameById[rec.employeeId];
        const date = rec.baseDate;
        if (!name || !date) continue;
        if (date < startYmd || date > endYmd) continue; // API가 요청 범위 밖 날짜를 같이 돌려줄 때가 있어 방어
        const clockIn = isoToHm(rec.checkInTime);
        const clockOut = isoToHm(rec.checkOutTime);
        const recognizedMin = isoDurationToMinutes(rec.recognizedWork);
        const overtimeMin = isoDurationToMinutes(rec.overtime);
        if (!clockIn && !clockOut && !recognizedMin) continue; // 출퇴근도 인정근무도 없는 날은 저장하지 않음
        const late = !!(rec.late && rec.late !== 'PT0S');
        byDate[date] = byDate[date] || {};
        byDate[date][name] = { clockIn, clockOut, late, recognizedMin, overtimeMin };
    }
    return byDate;
}

async function writeFirebaseAttendance(monthKey, byDate, infoByName, idToken) {
    const auth = '?auth=' + encodeURIComponent(idToken);
    const attUrl = FIREBASE_DB_URL + '/attendance/' + monthKey + '.json' + auth;
    const metaUrl = FIREBASE_DB_URL + '/attendance/_meta.json' + auth;
    const empUrl = FIREBASE_DB_URL + '/employee_info.json' + auth;

    const attRes = await fetch(attUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(byDate) });
    if (!attRes.ok) throw new Error('Firebase write failed: ' + attRes.status + ' ' + (await attRes.text()));

    await fetch(metaUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastSyncAt: Date.now(), lastSyncMonth: monthKey, lastSyncCount: Object.keys(byDate).length, lastSyncSource: 'extension' }),
    });
    await fetch(empUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(infoByName) });
}

async function runAttendanceSync({ force = false } = {}) {
    const auth = await getValidAuth();
    if (!auth) throw new Error('로그인 필요 — 확장 팝업에서 로그인하세요');

    if (!force) {
        const { lastAttendanceSyncAt = 0 } = await chrome.storage.local.get(['lastAttendanceSyncAt']);
        if (Date.now() - lastAttendanceSyncAt < ATTENDANCE_SYNC_THROTTLE_MS) {
            return { skipped: true, reason: 'throttled', nextEligibleAt: lastAttendanceSyncAt + ATTENDANCE_SYNC_THROTTLE_MS };
        }
    }

    const employeeList = await fetchEmployeeInfoList();
    const { idByName, infoByName } = transformEmployeeInfo(employeeList);
    const employeeIds = Object.values(idByName);
    if (!employeeIds.length) throw new Error('조직원 목록을 가져오지 못했습니다');

    const { startYmd, endYmd } = monthStartEndYmd();
    const wtPayload = await fetchTeamWorktimes(employeeIds, startYmd, endYmd);
    const byDate = transformAttendance(idByName, wtPayload, startYmd, endYmd);
    const monthKey = currentMonthKey();
    await writeFirebaseAttendance(monthKey, byDate, infoByName, auth.idToken);

    const lastAttendanceSyncAt = Date.now();
    await chrome.storage.local.set({ lastAttendanceSyncAt, lastAttendanceSyncCount: Object.keys(byDate).length });
    return { skipped: false, count: Object.keys(byDate).length, month: monthKey };
}
