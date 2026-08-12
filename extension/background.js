// Service Worker — 그룹웨어 페이지 방문 감지 + 알람 주기 동기화
importScripts('common.js');

const ALARM_NAME = 'leave-sync-tick';
const TAB_THROTTLE_MS = 5 * 60 * 1000; // 같은 탭이 너무 자주 트리거되는 것 방지

// 설치/시작 시 알람 등록 (1시간마다)
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 60 });
});

chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.get(ALARM_NAME, (a) => {
        if (!a) chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 60 });
    });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    await tryRunSync('alarm');
});

// 그룹웨어 페이지 방문/로드 감지 → 동기화 시도 (스로틀 안에서)
let lastTabTriggerAt = 0;
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'complete') return;
    if (!tab || !tab.url) return;
    if (!/^https:\/\/jiran\.groupware\.pro\//.test(tab.url)) return;
    if (Date.now() - lastTabTriggerAt < TAB_THROTTLE_MS) return;
    lastTabTriggerAt = Date.now();
    await tryRunSync('tab:' + new URL(tab.url).pathname);
});

// 그룹웨어 API 요청의 인증 헤더를 가로채 저장한다.
// 그룹웨어 SSO에 인증 단계가 추가돼 쿠키(credentials:include)만으로 API 인가가
// 안 되는 경우, 페이지가 실제로 보내는 Authorization 등 헤더를 재사용하기 위함.
// 사용자가 그룹웨어 인사/연차 화면을 열면 그 요청에서 토큰을 확보한다.
const GW_API_FILTER = { urls: ['https://jiran.api.groupware.pro/*'] };
const CAPTURE_HEADER_NAMES = ['authorization', 'x-auth-token', 'x-access-token'];

chrome.webRequest.onSendHeaders.addListener(
    (details) => {
        try {
            if (!Array.isArray(details.requestHeaders)) return;
            const grabbed = {};
            for (const h of details.requestHeaders) {
                if (!h || !h.value) continue;
                if (CAPTURE_HEADER_NAMES.indexOf((h.name || '').toLowerCase()) !== -1) {
                    grabbed[h.name] = h.value;
                }
            }
            if (Object.keys(grabbed).length > 0) {
                chrome.storage.local.set({ gwHeaders: grabbed, gwHeadersAt: Date.now() });
            }
        } catch (_) { /* 관찰 전용 — 실패해도 무시 */ }
    },
    GW_API_FILTER,
    ['requestHeaders', 'extraHeaders']
);

async function tryRunSync(trigger) {
    try {
        const r = await runSync();
        if (r.skipped) {
            console.log('[leave-sync] skipped (' + trigger + '): ' + r.reason);
            return;
        }
        console.log('[leave-sync] ' + trigger + ' → ' + r.count + '명 동기화');
        notify('연차 동기화 완료', r.count + '명 (' + r.year + '년) — ' + new Date().toLocaleTimeString('ko-KR'));
    } catch (e) {
        const msg = String(e && e.message || e);
        console.warn('[leave-sync] failed (' + trigger + '): ' + msg);
        if (/로그인 필요/.test(msg) || /TOKEN/.test(msg)) {
            notify('연차 동기화 실패', '확장 팝업에서 로그인이 필요합니다');
        } else if ((e && (e.status === 401 || e.status === 403)) || /그룹웨어 API HTTP 4/.test(msg)) {
            if (e && e.needsToken) {
                notify('연차 동기화 실패', '그룹웨어 인증 정보가 없습니다. 그룹웨어 인사/연차 화면을 한 번 열어 인증을 갱신해 주세요.');
            } else {
                notify('연차 동기화 실패', '그룹웨어 인증이 만료됐습니다. 그룹웨어에 다시 로그인(추가 인증 포함)한 뒤 인사 화면을 열어 주세요.');
            }
        } else {
            notify('연차 동기화 실패', msg.substring(0, 120));
        }
    }
}

function notify(title, message) {
    try {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title,
            message,
            priority: 0,
        });
    } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 그룹웨어를 백그라운드 탭으로 잠깐 열어 인증 토큰(Authorization)을 다시 캡처한다.
// 세션이 살아있으면 페이지의 API 호출에서 onSendHeaders가 새 토큰을 저장 → true.
// 로그인 안 돼 있으면(로그인 페이지로 리다이렉트) 토큰이 안 잡혀 → false.
async function refreshGwTokenViaTab() {
    const before = (await chrome.storage.local.get(['gwHeadersAt'])).gwHeadersAt || 0;
    let tab;
    try {
        tab = await chrome.tabs.create({ url: 'https://jiran.groupware.pro/', active: false });
    } catch (_) {
        return false;
    }
    try {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            await sleep(500);
            const { gwHeadersAt } = await chrome.storage.local.get(['gwHeadersAt']);
            if (gwHeadersAt && gwHeadersAt > before) return true; // 새 토큰 확보
        }
        return false;
    } finally {
        if (tab && tab.id != null) {
            try { await chrome.tabs.remove(tab.id); } catch (_) {}
        }
    }
}

// 출퇴근 조회: 인증 실패(401/403)면 그룹웨어 탭으로 토큰을 재확보한 뒤 1회 재시도.
// 세션이 살아있는 한 사용자가 직접 재접속하지 않아도 자동으로 갱신된다.
async function fetchWorktimesWithAutoAuth(startYmd, endYmd) {
    try {
        return await fetchWorktimes(startYmd, endYmd);
    } catch (e) {
        const authFail = e && (e.status === 401 || e.status === 403);
        if (!authFail) throw e;
        const refreshed = await refreshGwTokenViaTab();
        if (!refreshed) {
            const err = new Error(
                '그룹웨어 인증을 갱신하지 못했습니다 — 그룹웨어에 로그인(추가 인증 포함)돼 있는지 확인 후 다시 시도하세요'
            );
            err.status = e.status;
            throw err;
        }
        return await fetchWorktimes(startYmd, endYmd);
    }
}

// 팝업 → 백그라운드 메시지: 수동 동기화 요청
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'sync-now') {
        runSync({ force: true })
            .then(r => sendResponse({ ok: true, result: r }))
            .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true; // async
    }
    if (msg && msg.type === 'sync-attendance-now') {
        runAttendanceSync({ force: true })
            .then(r => sendResponse({ ok: true, result: r }))
            .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true; // async
    }
    // 일일 진행업무 앱(콘텐츠 스크립트)에서 온 출퇴근 조회 요청
    if (msg && msg.type === 'dwl-get-worktimes') {
        fetchWorktimesWithAutoAuth(msg.startYmd, msg.endYmd)
            .then(data => sendResponse({ ok: true, data }))
            .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true; // async
    }
});
