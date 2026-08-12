(async function() {
    const $ = (id) => document.getElementById(id);
    const loggedOut = $('loggedOut');
    const loggedIn = $('loggedIn');
    const bootStatus = $('bootStatus');
    const syncStatus = $('syncStatus');
    const attendanceSyncStatus = $('attendanceSyncStatus');

    function show(state) {
        bootStatus.style.display = 'none';
        loggedOut.style.display = state === 'out' ? 'block' : 'none';
        loggedIn.style.display = state === 'in' ? 'block' : 'none';
    }

    function setStatus(el, text, kind) {
        el.textContent = text;
        el.className = 'status ' + (kind || 'info');
    }

    function fmtAgo(ts) {
        if (!ts) return '정보 없음';
        const diff = Date.now() - ts;
        const min = Math.floor(diff / 60000);
        const hr = Math.floor(diff / 3600000);
        const day = Math.floor(diff / 86400000);
        let ago;
        if (diff < 60000) ago = '방금 전';
        else if (min < 60) ago = min + '분 전';
        else if (hr < 24) ago = hr + '시간 전';
        else ago = day + '일 전';
        const d = new Date(ts);
        const stamp = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
                    + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
        return ago + ' (' + stamp + ')';
    }

    async function refreshStatusLine() {
        const { lastSyncAt, lastSyncCount } = await chrome.storage.local.get(['lastSyncAt', 'lastSyncCount']);
        if (!lastSyncAt) {
            setStatus(syncStatus, '최근 동기화: 정보 없음', 'info');
        } else {
            setStatus(syncStatus, '최근 동기화: ' + fmtAgo(lastSyncAt) + (lastSyncCount ? ' / ' + lastSyncCount + '명' : ''), 'success');
        }
    }

    async function refreshAttendanceStatusLine() {
        if (!attendanceSyncStatus) return;
        const { lastAttendanceSyncAt, lastAttendanceSyncCount } = await chrome.storage.local.get(['lastAttendanceSyncAt', 'lastAttendanceSyncCount']);
        if (!lastAttendanceSyncAt) {
            setStatus(attendanceSyncStatus, '최근 동기화: 정보 없음', 'info');
        } else {
            setStatus(attendanceSyncStatus, '최근 동기화: ' + fmtAgo(lastAttendanceSyncAt) + (lastAttendanceSyncCount != null ? ' / ' + lastAttendanceSyncCount + '일' : ''), 'success');
        }
    }

    async function refreshGwAuthLine() {
        const el = $('gwAuthStatus');
        if (!el) return;
        const { gwHeadersAt, lastSyncAt } = await chrome.storage.local.get(['gwHeadersAt', 'lastSyncAt']);
        // 그룹웨어가 쿠키 세션만으로 인가하는 환경에서는 가로챌 토큰이 없으므로,
        // 최근 동기화가 성공했다면 토큰이 없어도 '정상(세션 쿠키)'으로 표시한다.
        const syncedRecently = lastSyncAt && (Date.now() - lastSyncAt < 26 * 60 * 60 * 1000);
        if (gwHeadersAt) {
            setStatus(el, '그룹웨어 인증: 확보됨 (토큰 ' + fmtAgo(gwHeadersAt) + ')', 'success');
        } else if (syncedRecently) {
            setStatus(el, '그룹웨어 연동: 정상 (세션 쿠키)', 'success');
        } else {
            setStatus(el, '그룹웨어 인증: 미확보 — 그룹웨어 인사/연차 화면을 한 번 열어주세요', 'error');
        }
    }

    const auth = await getValidAuth();
    if (auth) {
        $('userEmail').textContent = auth.email || '(unknown)';
        show('in');
        await refreshStatusLine();
        await refreshAttendanceStatusLine();
        await refreshGwAuthLine();
    } else {
        show('out');
    }

    $('resetBtn').addEventListener('click', async () => {
        const btn = $('resetBtn');
        const statusEl = $('resetStatus');
        const email = $('email').value.trim();
        if (!email) { statusEl.className = 'status error'; statusEl.textContent = '이메일을 먼저 입력하세요'; return; }
        btn.disabled = true; btn.textContent = '전송 중...';
        statusEl.className = ''; statusEl.textContent = '';
        try {
            await sendPasswordResetEmail(email);
            statusEl.className = 'status success'; statusEl.textContent = '재설정 이메일을 전송했습니다. 받은 편지함을 확인하세요.';
        } catch (e) {
            statusEl.className = 'status error'; statusEl.textContent = '실패: ' + (e && e.message || e);
        } finally {
            btn.disabled = false; btn.textContent = '비밀번호 재설정 이메일 전송';
        }
    });

    $('loginBtn').addEventListener('click', async () => {
        const btn = $('loginBtn');
        btn.disabled = true; btn.textContent = '로그인 중...';
        try {
            const email = $('email').value.trim();
            const password = $('password').value;
            if (!email || !password) throw new Error('이메일/비밀번호를 입력하세요');
            const result = await signInWithPassword(email, password);
            await chrome.storage.local.set({ auth: result });
            $('userEmail').textContent = result.email;
            show('in');
            await refreshStatusLine();
            await refreshAttendanceStatusLine();
            await refreshGwAuthLine();
        } catch (e) {
            // 실패 사유는 진단에 중요하므로 자동으로 사라지지 않고 다음 시도 전까지 유지한다.
            let box = $('loginError');
            if (!box) {
                box = document.createElement('div');
                box.id = 'loginError';
                loggedOut.appendChild(box);
            }
            box.className = 'status error';
            box.textContent = '로그인 실패: ' + (e && e.message || e);
        } finally {
            btn.disabled = false; btn.textContent = '로그인';
        }
    });

    $('logoutBtn').addEventListener('click', async () => {
        await chrome.storage.local.remove(['auth', 'lastSyncAt', 'lastSyncCount', 'lastAttendanceSyncAt', 'lastAttendanceSyncCount']);
        show('out');
    });

    $('syncBtn').addEventListener('click', async () => {
        const btn = $('syncBtn');
        btn.disabled = true; btn.textContent = '동기화 중...';
        setStatus(syncStatus, '동기화 진행 중...', 'info');
        try {
            const resp = await chrome.runtime.sendMessage({ type: 'sync-now' });
            if (resp && resp.ok) {
                const r = resp.result || {};
                if (r.skipped) {
                    setStatus(syncStatus, '스로틀로 건너뜀 (' + r.reason + ')', 'info');
                } else {
                    setStatus(syncStatus, '동기화 완료 / ' + r.count + '명', 'success');
                }
            } else {
                setStatus(syncStatus, '실패: ' + ((resp && resp.error) || '응답 없음'), 'error');
            }
            await refreshStatusLine();
            await refreshGwAuthLine();
        } catch (e) {
            setStatus(syncStatus, '실패: ' + (e && e.message || e), 'error');
        } finally {
            btn.disabled = false; btn.textContent = '연차 동기화';
        }
    });

    $('attendanceSyncBtn').addEventListener('click', async () => {
        const btn = $('attendanceSyncBtn');
        btn.disabled = true; btn.textContent = '동기화 중...';
        setStatus(attendanceSyncStatus, '동기화 진행 중...', 'info');
        try {
            const resp = await chrome.runtime.sendMessage({ type: 'sync-attendance-now' });
            if (resp && resp.ok) {
                const r = resp.result || {};
                if (r.skipped) {
                    setStatus(attendanceSyncStatus, '스로틀로 건너뜀 (' + r.reason + ')', 'info');
                } else {
                    setStatus(attendanceSyncStatus, '동기화 완료 / ' + r.month + ' ' + r.count + '일', 'success');
                }
            } else {
                setStatus(attendanceSyncStatus, '실패: ' + ((resp && resp.error) || '응답 없음'), 'error');
            }
            await refreshAttendanceStatusLine();
            await refreshGwAuthLine();
        } catch (e) {
            setStatus(attendanceSyncStatus, '실패: ' + (e && e.message || e), 'error');
        } finally {
            btn.disabled = false; btn.textContent = '출퇴근 동기화';
        }
    });
})();
