/* ============================================================
   大家小本 · 书本引擎 v2（CSS 3D 单路径）
   视觉：ASSET-03 背景 / ASSET-04 封面 / ASSET-05 双页（同旧版）
   交互：点封面开书（无扣件）；翻页纸叶；FOCUS 整组隐藏。
   契约：宿主 React 通过 __stage1 + postMessage 驱动；
         嵌入模式为常态；独立打开时自带轻量引导。
   ============================================================ */

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* 老浏览器 roundRect 兜底 */
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(typeof r === 'number' ? r : 4, w / 2, h / 2);
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w + r, y, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}

/* ---------------- IndexedDB（本机持久化，localStorage 兜底） ---------------- */
const DB_NAME = 'djbk-db';
const DB_VER = 1;
const STORE = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => resolve(rq.result ?? null);
      rq.onerror = () => reject(rq.error);
    });
  } catch (e) {
    console.warn('[idbGet fallback]', e);
    try { return JSON.parse(localStorage.getItem('djbk:' + key) || 'null'); } catch { return null; }
  }
}

async function idbSet(key, value) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[idbSet fallback]', e);
    try { localStorage.setItem('djbk:' + key, JSON.stringify(value)); return true; } catch { return false; }
  }
}

/* ---------------- 默认头像（程序生成，面板兜底） ---------------- */
function defaultAvatar() {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const x = c.getContext('2d');
  x.fillStyle = '#F4EEDB';
  x.fillRect(0, 0, 160, 160);
  x.fillStyle = '#547D86';
  x.beginPath(); x.arc(80, 62, 26, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.arc(80, 158, 54, 0, Math.PI); x.fill();
  x.fillStyle = '#FFFCF4';
  x.beginPath(); x.arc(71, 58, 3.4, 0, Math.PI * 2); x.arc(89, 58, 3.4, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#FFFCF4';
  x.lineWidth = 3; x.lineCap = 'round';
  x.beginPath(); x.arc(80, 65, 7, 0.25 * Math.PI, 0.75 * Math.PI); x.stroke();
  return c.toDataURL('image/png');
}

/* ---------------- 元素 ---------------- */
const stageEl = $('#stage');
const canvasEl = $('#gl');
const ribbonEl = $('#ribbon');
const toastEl = $('#toast');
const btnPrev = $('#btnPrev');
const btnNext = $('#btnNext');
const navLinks = Array.from(document.querySelectorAll('.links a[data-nav]'));
const panelWrap = $('#panelWrap');
const nickInput = $('#nickInput');
const enterBtn = $('#enterBtn');
const defaultAvatarBtn = null;
const drawCanvas = $('#draw');

/* ---------------- 状态机：closed → opening → open → closing → closed ---------------- */
const DUR_OPEN = 660;    // 稳定展开：封面左移，双页从书脊同步展开
const DUR_SETTLE = 80;   // 翻盖完成后的短暂稳定时间
const DUR_FLIP = 560;    // 纸叶翻页
const state = {
  phase: 'closed',
  profile: null,
  arrows: { prev: false, next: false },
};
let openT1 = null, openT2 = null, closeT = null, flipT = null;
let fbCard = null, fbSpread = null, fbLeaf = null;

const post = (msg) => { try { parent.postMessage(msg, '*'); } catch (_e) { /* 独立模式无父窗口 */ } };
const embedded = (() => { try { return window.parent !== window; } catch (_e) { return false; } })();

/* ---------------- 提示 ---------------- */
let toastT = null;
function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('on'), 2600);
}

/* ---------------- 降级 DOM：封面卡 + 摊开双页 + 翻页纸叶 ---------------- */
function initBook() {
  document.body.classList.add('no-gl');
  canvasEl.remove();   // CSS 路径不需要画布

  fbCard = document.createElement('div');
  fbCard.className = 'fbc';
  fbCard.setAttribute('role', 'button');
  fbCard.setAttribute('tabindex', '0');
  fbCard.setAttribute('aria-label', '打开账本');

  fbSpread = document.createElement('div');
  fbSpread.className = 'fbs';
  fbSpread.innerHTML = '<div class="pg l"></div><div class="pg r"></div>';

  stageEl.append(fbCard, fbSpread);

  /* 点封面开书（单飞守卫：opening 期间重复点击无效） */
  fbCard.addEventListener('click', () => { open(); });
  fbCard.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
  });
}

function open() {
  if (state.phase === 'closing') return;
  if (state.phase !== 'closed') return;
  state.phase = 'opening';
  /* 先把展开页放在封面下方；封面翻到左侧时，右页自然显露。 */
  fbSpread.classList.add('on');
  fbCard.classList.add('opening');
  clearTimeout(openT1); clearTimeout(openT2);
  openT1 = setTimeout(() => {
    /* 封面已与左页重合，此时隐藏其背面，保留完整双页。 */
    fbCard.classList.add('gone');
    syncArrows();
    syncRibbon();
    openT2 = setTimeout(() => {
      state.phase = 'open';
      syncRibbon();
      post({ type: 'djbk:book-open' });
    }, DUR_SETTLE);
  }, DUR_OPEN);
}

function closeBook() {
  if (state.phase === 'closed' || state.phase === 'closing') return;
  clearTimeout(openT1); clearTimeout(openT2); clearTimeout(flipT);
  removeLeaf();
  state.phase = 'closing';
  syncArrows();
  document.body.classList.remove('focus');
  /* 从左页位置把封面翻回右侧；双页在动画完成前保持原位。 */
  fbCard.classList.remove('gone');
  requestAnimationFrame(() => requestAnimationFrame(() => fbCard.classList.remove('opening')));
  closeT = setTimeout(() => {
    fbSpread.classList.remove('on');
    state.phase = 'closed';
    syncRibbon();
    post({ type: 'djbk:book-closed' });
  }, DUR_OPEN);
}

/* ---------------- 翻页（纸叶绕中央书沟） ---------------- */
function removeLeaf() {
  if (fbLeaf) { fbLeaf.remove(); fbLeaf = null; }
}

function flipBook(dir) {
  if (state.phase !== 'open' || flipT) return false;
  removeLeaf();
  post({ type: 'djbk:flip-start' });
  fbLeaf = document.createElement('div');
  fbLeaf.className = 'fbleaf';
  if (dir < 0) {
    /* 向左翻：纸叶盖在左页，向右荡出 */
    fbLeaf.style.transform = 'translate(-150%, -50%) rotateY(0deg)';
  }
  stageEl.append(fbLeaf);
  requestAnimationFrame(() => {
    if (!fbLeaf) return;
    const base = dir < 0 ? 'translate(-150%, -50%)' : 'translate(-50%, -50%)';
    fbLeaf.style.transform = `${base} rotateY(${dir > 0 ? -180 : 180}deg)`;
  });
  flipT = setTimeout(() => {
    removeLeaf();
    flipT = null;
    post({ type: 'djbk:flip-done', dir });
  }, DUR_FLIP);
  return true;
}

/* ---------------- 页面四边形（宿主把预览内容贴到书页上） ---------------- */
function pageQuad() {
  if (state.phase !== 'open' || !fbSpread) return null;
  const out = {};
  const pairs = [['left', '.pg.l'], ['right', '.pg.r']];
  for (const [k, sel] of pairs) {
    const el = fbSpread.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    /* iframe 铺满父视口且位于 (0,0)：iframe 坐标即父窗口坐标 */
    out[k] = {
      tl: [r.left, r.top],
      tr: [r.right, r.top],
      bl: [r.left, r.bottom],
      br: [r.right, r.bottom],
    };
  }
  return out;
}

/* ---------------- 丝带书签：贴书底中缝右侧 ---------------- */
function syncRibbon() {
  if (!ribbonEl) return;
  const anchor = (state.phase === 'open' || state.phase === 'closing') ? fbSpread : fbCard;
  if (!anchor) { ribbonEl.style.opacity = '0'; return; }
  const r = anchor.getBoundingClientRect();
  ribbonEl.style.left = Math.round(r.left + r.width * 0.5 + 10) + 'px';
  ribbonEl.style.top = Math.round(r.bottom - 10) + 'px';
  ribbonEl.style.opacity = (state.phase === 'open') ? '1' : '0.9';
}

/* ---------------- 翻页箭头 ---------------- */
function syncArrows() {
  const show = state.phase === 'open';
  const pairs = [[btnPrev, 'prev'], [btnNext, 'next']];
  for (const [btn, k] of pairs) {
    if (!btn) continue;
    btn.classList.toggle('on', show);
    btn.disabled = !state.arrows[k];
  }
}

/* ---------------- 顶部导航（在 iframe 内；点击交给宿主路由） ---------------- */
function bindNav() {
  for (const a of navLinks) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const nav = a.dataset.nav;
      if (embedded) post({ type: 'djbk:nav', nav });
      else toast(`「${nav}」请从预览页使用`);
    });
  }
  for (const [btn, dir] of [[btnPrev, -1], [btnNext, 1]]) {
    if (!btn) continue;
    btn.addEventListener('click', () => {
      if (btn.disabled || flipT) return;
      post({ type: 'djbk:arrow', dir });
    });
  }
}

function setActiveNav(nav) {
  for (const a of navLinks) {
    a.classList.toggle('on', !!nav && a.dataset.nav === nav);
    if (nav && a.dataset.nav === nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

/* ---------------- 独立模式轻量引导（嵌入模式由 React 负责） ---------------- */
function applyProfile() {
  if (!state.profile) return;
  if (nickInput && state.profile.nick) nickInput.value = state.profile.nick;
}

function saveProfile() {
  const nick = (nickInput ? nickInput.value : '').trim();
  if (!nick) { toast('先写个昵称吧'); return; }
  state.profile = {
    nick,
    avatar: (drawAvatarDataURL() || defaultAvatar()),
  };
  idbSet('profile', state.profile);
  applyProfile();
  if (panelWrap) panelWrap.hidden = true;
  toast(`欢迎，${nick}`);
}

/* 简笔头像画板（仅独立模式；嵌入模式用宿主 AvatarPad） */
let brush = { color: '#547D86', size: 10, mode: 'brush' };
function drawAvatarDataURL() {
  try { return drawCanvas && drawCanvas.__dirty ? drawCanvas.toDataURL('image/png') : null; }
  catch (_e) { return null; }
}

function bindDrawEvents() {
  if (!drawCanvas) return;
  const ctx = drawCanvas.getContext('2d');
  let painting = false, last = null;
  drawCanvas.__dirty = false;

  const pos = (ev) => {
    const r = drawCanvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) * drawCanvas.width / r.width,
      y: (ev.clientY - r.top) * drawCanvas.height / r.height,
    };
  };
  const stroke = (from, to) => {
    ctx.strokeStyle = brush.mode === 'eraser' ? '#FFFCF4' : brush.color;
    ctx.lineWidth = brush.size;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    drawCanvas.__dirty = true;
  };
  drawCanvas.addEventListener('pointerdown', (ev) => {
    painting = true; last = pos(ev);
    stroke(last, { x: last.x + 0.1, y: last.y + 0.1 });
    drawCanvas.setPointerCapture(ev.pointerId);
  });
  drawCanvas.addEventListener('pointermove', (ev) => {
    if (!painting) return;
    const p = pos(ev);
    stroke(last, p); last = p;
  });
  const stop = () => { painting = false; last = null; };
  drawCanvas.addEventListener('pointerup', stop);
  drawCanvas.addEventListener('pointercancel', stop);

  /* 工具与颜色 */
  const brushBtn = $('#toolBrush'), eraserBtn = $('#toolEraser');
  const setMode = (m) => {
    brush.mode = m;
    if (brushBtn) brushBtn.classList.toggle('on', m === 'brush');
    if (eraserBtn) eraserBtn.classList.toggle('on', m === 'eraser');
  };
  if (brushBtn) brushBtn.addEventListener('click', () => setMode('brush'));
  if (eraserBtn) eraserBtn.addEventListener('click', () => setMode('eraser'));

  const colors = $('#colors');
  if (colors) {
    const PALETTE = ['#547D86', '#E6A69C', '#BCCBAA', '#D8A6A0', '#344C54', '#C9A227'];
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = c;
      b.setAttribute('aria-label', c);
      b.addEventListener('click', () => { brush.color = c; setMode('brush'); });
      colors.append(b);
    }
  }
  for (const b of document.querySelectorAll('.tbtn.sz')) {
    b.addEventListener('click', () => {
      brush.size = Number(b.dataset.size) || 10;
      document.querySelectorAll('.tbtn.sz').forEach((x) => x.classList.toggle('on', x === b));
    });
  }
  const clearBtn = $('#clearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    ctx.fillStyle = '#FFFCF4';
    ctx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
    drawCanvas.__dirty = false;
  });
  if (false) defaultAvatarBtn.addEventListener('click', () => {
    ctx.fillStyle = '#FFFCF4';
    ctx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
    ctx.drawImage((() => { const i = new Image(); return i; })(), 0, 0);
    toast('保存时会使用默认头像');
  });
}

function bindPanel() {
  if (enterBtn) enterBtn.addEventListener('click', saveProfile);
  if (nickInput) nickInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); saveProfile(); }
  });
}

/* ---------------- 宿主消息 ---------------- */
window.addEventListener('message', (ev) => {
  if (ev.source !== parent) return;
  const d = ev.data || {};
  switch (d.type) {
    case 'djbk:open': open(); break;
    case 'djbk:close': closeBook(); break;
    case 'djbk:focus':
      document.body.classList.toggle('focus', !!d.on);
      break;
    case 'djbk:arrows':
      state.arrows = { prev: !!d.prev, next: !!d.next };
      syncArrows();
      break;
    case 'djbk:nav-active':
      setActiveNav(d.nav);
      break;
    default: break;
  }
});

window.addEventListener('resize', () => { syncRibbon(); });

/* ---------------- 启动 ---------------- */
(async function init() {
  state.profile = await idbGet('profile');

  initBook();
  bindNav();
  bindPanel();
  bindDrawEvents();
  syncRibbon();
  applyProfile();

  /* 独立打开且无资料：弹自带引导；嵌入模式由 React 引导 */
  if (!embedded && !state.profile && panelWrap) panelWrap.hidden = false;

  window.__stage1 = {
    open,
    close: closeBook,
    flipBook,
    get phase() { return state.phase; },
    pageQuad,
    profile: () => state.profile,
    save: saveProfile,
    repaint: () => { /* 兼容旧口：内容由宿主渲染 */ },
    boxScreenBounds: () => {
      const el = (state.phase === 'open') ? fbSpread : fbCard;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(innerWidth - r.right),
        top: Math.round(r.top),
        bottom: Math.round(innerHeight - r.bottom),
      };
    },
  };

  /* 告诉宿主：引擎就绪（宿主据此可查询 phase/pageQuad） */
  if (embedded) post({ type: 'djbk:book-ready' });
})();
