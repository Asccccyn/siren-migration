/**
 * Playground 登录门：无 token 时弹全屏密码框。
 * 与语音信箱同一条密码通道（SIREN_WEB_PASSWORD → /v1/web/login 换 API token），
 * 人永远只面对自己设置的密码，不接触 48 位机器 token。
 */

const STORAGE_KEY = 'siren_token';

/** 统一的 token 读取口：剥掉误粘的 "Bearer " 前缀并写回（页面各处只准从这里取） */
export function getStoredToken(): string {
  const raw = (localStorage.getItem(STORAGE_KEY) ?? '').trim();
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
  if (token !== raw) localStorage.setItem(STORAGE_KEY, token);
  return token;
}

/** 密码换 token；成功返回 token，失败返回 null 并给出错误文案 */
async function loginWithPassword(password: string): Promise<{ token: string } | { error: string }> {
  try {
    const res = await fetch('/v1/web/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (res.status === 401) return { error: '密码不对，再想想' };
    if (res.status === 429) return { error: '试得太频繁了，一分钟后再来' };
    if (res.status === 503) return { error: '服务端还没设置密码（SIREN_WEB_PASSWORD）' };
    if (!res.ok) return { error: `登录失败（HTTP ${res.status}）` };
    return { token: (await res.json()).token as string };
  } catch (e) {
    return { error: `连不上服务：${(e as Error).message}` };
  }
}

function mountGate(): void {
  const overlay = document.createElement('div');
  overlay.id = 'siren-login-gate';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
    "background:#070b15;font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif";
  overlay.innerHTML = `
    <div style="background:#111b2bcc;backdrop-filter:blur(14px);border:1px solid #223049;
                border-radius:18px;padding:32px 34px;width:min(380px,86vw);color:#f1eddf;box-shadow:0 18px 50px rgba(0,0,0,.45)">
      <div style="font-family:'Songti SC',Georgia,serif;font-size:38px;font-weight:500;letter-spacing:.22em;margin-bottom:4px">听见</div>
      <div style="font-size:13px;color:#aebbce;margin-bottom:18px">听见 · 输入你的密码</div>
      <input id="siren-gate-pwd" type="password" placeholder="密码" autocomplete="off"
             style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:8px;border:1px solid #65748d;
                    border-bottom-width:1px;background:#0d1522;color:#f1eddf;font-size:14px;outline:none;caret-color:#dbc78e" />
      <div id="siren-gate-err" style="color:#e99b9b;font-size:12px;min-height:18px;margin-top:8px"></div>
      <button id="siren-gate-go" style="width:100%;padding:11px;border:1px solid #bcb397;border-radius:8px;cursor:pointer;
              background:#d9d1b9;color:#152030;font-size:14px;font-weight:600;letter-spacing:.06em">进来</button>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#siren-gate-pwd') as HTMLInputElement;
  const err = overlay.querySelector('#siren-gate-err') as HTMLDivElement;
  const go = overlay.querySelector('#siren-gate-go') as HTMLButtonElement;
  const submit = async (): Promise<void> => {
    const password = input.value.trim();
    if (!password) return;
    go.disabled = true;
    go.textContent = '正在开门…';
    const result = await loginWithPassword(password);
    if ('token' in result) {
      localStorage.setItem(STORAGE_KEY, result.token);
      window.location.reload();
      return;
    }
    go.disabled = false;
    go.textContent = '进来';
    err.textContent = result.error;
    input.select();
  };
  go.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
  });
  input.focus();
}

function mountKeyButton(): void {
  const btn = document.createElement('button');
  btn.textContent = '🔑';
  btn.title = '修改访问密码';
  btn.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:9998;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.25);' +
    'background:rgba(30,22,56,.8);color:#c4b1ff;cursor:pointer;font-size:15px';
  btn.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    mountGate();
  });
  document.body.appendChild(btn);
}

/** 各页面入口调用一次 */
export function requireToken(): void {
  if (getStoredToken()) {
    mountKeyButton();
    return;
  }
  mountGate();
}
