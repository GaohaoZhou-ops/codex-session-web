import './styles.css';
import { activityText, findMatches, groupMessages, MAX_FILE_BYTES, messagePreview, parseConversation } from './parser.js';
import { escapeHTML, highlightMatches, renderMarkdown } from './markdown.js';
import { icon } from './icons.js';
import { deleteCachedSession, findCachedSession, planSessionUpdate, readCacheIndex, readCachedText, saveCachedSession, sessionId, sessionNames } from './session-cache.js';
import { formatSessionTime, sessionStartTime } from './session-time.js';

const $ = (selector) => document.querySelector(selector);
const storage = {
  get(key) { try { return localStorage.getItem(`codex-reader:${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`codex-reader:${key}`, value); } catch { /* Reading works without storage. */ } },
  remove(key) { try { localStorage.removeItem(`codex-reader:${key}`); } catch { /* Reading works without storage. */ } },
};
const LIBRARY_PAGE_SIZE = 50;
const VIEW_MODES = [
  { value: 'conversation', label: '对话视图', description: '工具活动默认折叠', icon: 'chat' },
  { value: 'compact', label: '精简视图', description: '只看提问与本轮最后回复', icon: 'book' },
  { value: 'full', label: '完整记录', description: '展开全部工具活动与输出', icon: 'terminal' },
];
const state = { sessions: [], directoryFiles: [], cachedSessions: new Map(), directoryLinks: new Map(), libraryLimit: LIBRARY_PAGE_SIZE, current: null, loadingId: null, selectionVersion: 0, view: storage.get('view') || 'conversation', query: '', matches: [], matchIndex: -1, loadVersion: 0, theme: storage.get('theme') || 'light', messageElements: new Map(), groupElements: new Map(), activeId: null };
// File bodies normally live only in IndexedDB and in the active reader. This
// fallback keeps reading usable when storage is disabled or its quota is full.
const temporaryTexts = new Map();
state.removedIds = new Set();
if (!['conversation', 'compact', 'full'].includes(state.view)) state.view = 'conversation';
const bytes = (size) => size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(0)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
const shortName = (name) => name.replace(/^codex-session-/, '').replace(/\.(md|markdown|txt)$/i, '');
function decodeFile(buffer) {
  try {
    // Retain a UTF-8 BOM so downloading the original text is byte-preserving.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch { throw new Error('文件不是 UTF-8 文本，请转换编码后重试。'); }
}
let toastTimeout;
let searchTimeout;
let dragDepth = 0;

document.documentElement.dataset.theme = state.theme;
$('#app').innerHTML = `
  <div class="app-shell">
    <button class="sidebar-backdrop" id="sidebar-backdrop" aria-label="关闭侧栏" hidden></button>
    <aside class="sidebar" id="sidebar" aria-label="会话与对话目录">
      <a class="brand" href="/" aria-label="Codex 会话阅读器首页"><span class="brand-mark">${icon('code')}</span><span>codex<span class="brand-subtitle">SESSION READER</span></span></a>
      <button class="open-button" id="open-file">${icon('plus')}<span>打开导出文件</span><kbd>⌘ O</kbd></button>
      <div class="sidebar-scroll">
        <section class="library-section">
          <div class="section-heading"><span>会话文件 <span id="session-count" class="count-badge">0</span></span><button class="icon-button small" id="refresh-files" title="刷新当前目录的导出文件" aria-label="刷新文件列表">${icon('refresh')}</button></div>
          <div id="session-list" class="session-list"></div>
          <button class="library-more" id="load-more-sessions" hidden>显示更多会话</button>
          <p class="library-note">当前目录与本机缓存的文件</p>
          <p class="cache-warning" id="cache-warning" role="status" hidden></p>
        </section>
        <section class="outline-section">
          <div class="section-heading"><span>对话目录</span>${icon('list')}</div>
          <nav id="outline" class="outline" aria-label="跳转到对话"></nav>
        </section>
      </div>
      <div class="sidebar-bottom"><span class="local-status"><span class="status-dot"></span>本地工作区</span></div>
      <div class="privacy-note">${icon('shield')}<span>文件在本机读取，安心回看。</span></div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="breadcrumb"><button class="icon-button mobile-menu" id="menu-toggle" aria-label="打开侧栏" aria-expanded="false">${icon('menu')}</button><span class="breadcrumb-icon">${icon('folder')}</span><span>工作区</span><span class="breadcrumb-slash">/</span><strong>会话阅读器</strong></div>
        <div class="topbar-actions">
          <span class="local-badge"><span class="status-dot"></span>LOCAL</span>
          <button class="theme-toggle" id="theme-toggle" type="button" aria-label="切换深色模式" title="切换深色模式"></button>
        </div>
      </header>
      <div class="reader-toolbar">
        <div class="search-box">${icon('search')}<input type="search" id="search-input" placeholder="搜索此会话…" aria-label="搜索此会话" autocomplete="off" spellcheck="false" /><kbd id="search-shortcut">Ctrl K</kbd><div class="search-controls" id="search-controls" hidden><span id="search-count" role="status" aria-live="polite"></span><button class="icon-button small" id="search-prev" title="上一条匹配 · Shift+Enter" aria-label="上一条匹配">${icon('up')}</button><button class="icon-button small" id="search-next" title="下一条匹配 · Enter" aria-label="下一条匹配">${icon('down')}</button><button class="icon-button small" id="search-clear" title="清除搜索" aria-label="清除搜索">${icon('close')}</button></div></div>
        <div class="toolbar-actions">
          <div class="view-select">
            <button class="view-trigger" id="view-mode" type="button" role="combobox" aria-label="阅读视图" aria-haspopup="listbox" aria-expanded="false" aria-controls="view-options">${icon('book')}<span id="view-label"></span>${icon('down', 'view-chevron')}</button>
            <div class="view-menu" id="view-options" role="listbox" aria-label="阅读视图选项" hidden>
              ${VIEW_MODES.map((mode) => `<button class="view-option" id="view-option-${mode.value}" type="button" role="option" data-view="${mode.value}" aria-selected="false" aria-labelledby="view-label-${mode.value}" aria-describedby="view-description-${mode.value}" tabindex="-1">${icon(mode.icon)}<span class="view-option-text"><span class="view-option-label" id="view-label-${mode.value}">${mode.label}</span><span class="view-option-description" id="view-description-${mode.value}">${mode.description}</span></span>${icon('check', 'view-check')}</button>`).join('')}
            </div>
          </div>
          <span class="toolbar-divider"></span><button class="icon-button" id="download-file" title="下载当前原始文件" aria-label="下载当前原始文件" disabled>${icon('download')}</button>
        </div>
      </div>
      <div class="error-banner" id="error-banner" role="alert" hidden><span id="error-message"></span><button class="icon-button small" id="dismiss-error" aria-label="关闭错误提示">${icon('close')}</button></div>
      <main class="reader" id="reader" aria-label="会话内容" tabindex="-1">
        <div class="reader-content" id="reader-content"></div>
      </main>
      <footer class="reader-footer"><span id="footer-info">Codex CLI /export · Markdown 阅读器</span><div class="footer-navigation"><span id="reading-progress">0%</span><button class="icon-button small" id="scroll-top" aria-label="回到顶部" title="回到顶部">${icon('arrowUp')}</button><button class="icon-button small" id="scroll-bottom" aria-label="跳到末尾" title="跳到末尾">${icon('arrowDown')}</button></div></footer>
    </div>
  </div>
  <input type="file" id="file-input" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden />
  <div class="drop-overlay" id="drop-overlay" hidden><div class="drop-card"><div class="drop-icon">${icon('upload')}</div><h2>松开，开始阅读</h2><p>将 Codex 导出文件放到这里</p><span>.md / .markdown / .txt · 最大 20 MB</span></div></div>
  <dialog class="delete-dialog" id="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description delete-filename delete-scope">
    <div class="delete-dialog-icon">${icon('trash')}</div>
    <h2 id="delete-title">删除此会话？</h2>
    <p id="delete-description">将从会话列表和本机缓存中删除以下会话。<strong>此操作无法撤销。</strong></p>
    <p class="delete-filename" id="delete-filename"></p>
    <p class="delete-scope">原始导出文件保留。如需再次阅读，请重新打开文件。</p>
    <p class="delete-error" id="delete-error" role="alert" hidden></p>
    <div class="delete-dialog-actions"><button class="cancel-delete" id="cancel-delete" type="button" autofocus>取消</button><button class="confirm-delete" id="confirm-delete" type="button">确认删除</button></div>
  </dialog>
  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>`;

const openFile = () => $('#file-input').click();
const setBusy = (busy) => {
  $('#reader').setAttribute('aria-busy', String(busy));
  if ($('#delete-session')) $('#delete-session').disabled = busy;
};
function toast(message) {
  clearTimeout(toastTimeout);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 3400);
}
function showError(message) { $('#error-message').textContent = message; $('#error-banner').hidden = false; }
function clearError() { $('#error-banner').hidden = true; }
function setSidebar(open) {
  $('#sidebar').classList.toggle('is-open', open);
  $('#sidebar-backdrop').hidden = !open;
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
}
function updateTheme() {
  document.documentElement.dataset.theme = state.theme;
  const nextTheme = state.theme === 'dark' ? '浅色模式' : '深色模式';
  $('#theme-toggle').innerHTML = `${icon(state.theme === 'dark' ? 'sun' : 'moon')}<span>${nextTheme}</span>`;
  const label = `切换${nextTheme}`;
  $('#theme-toggle').setAttribute('aria-label', label);
  $('#theme-toggle').title = label;
}

let viewOptionIndex = 0;
function focusViewOption(index) {
  viewOptionIndex = (index + VIEW_MODES.length) % VIEW_MODES.length;
  const activeId = `view-option-${VIEW_MODES[viewOptionIndex].value}`;
  $('#view-mode').setAttribute('aria-activedescendant', activeId);
  for (const option of $('#view-options').children) option.classList.toggle('is-focused', option.id === activeId);
}

function setViewMenu(open) {
  $('#view-options').hidden = !open;
  $('#view-mode').setAttribute('aria-expanded', String(open));
  if (open) focusViewOption(VIEW_MODES.findIndex((mode) => mode.value === state.view));
  else {
    $('#view-mode').removeAttribute('aria-activedescendant');
    for (const option of $('#view-options').children) option.classList.remove('is-focused');
  }
}

function updateViewControl() {
  $('#view-label').textContent = VIEW_MODES.find((mode) => mode.value === state.view).label;
  for (const option of $('#view-options').children) option.setAttribute('aria-selected', String(option.dataset.view === state.view));
}

function chooseView(value) {
  state.view = value;
  storage.set('view', state.view);
  setViewMenu(false);
  applyView();
  $('#view-mode').focus();
}

function warnCacheUnavailable() {
  $('#cache-warning').textContent = '浏览器缓存不可用，未保存的文件仅在本页保留。请检查站点存储权限或可用空间。';
  $('#cache-warning').hidden = false;
}

function rebuildLibrary() {
  const sessions = new Map();
  for (const directory of state.directoryFiles) {
    const link = state.directoryLinks.get(directory.name);
    const sameVersion = link?.size === directory.size && link?.modifiedAt === directory.modifiedAt;
    if (sameVersion && state.removedIds.has(link.id)) continue;
    const cached = sameVersion ? state.cachedSessions.get(link.id) : undefined;
    // An uploaded replacement takes precedence over an unchanged directory
    // copy. Keep its actual size and avoid re-reading older bytes on refresh.
    const session = cached && link.imported
      ? { ...cached, source: cached.cached ? 'cache' : 'temporary' }
      : { ...(cached || { id: `directory:${directory.name}` }), ...directory, directory, source: 'directory' };
    if (!sessions.has(session.id)) sessions.set(session.id, session);
  }
  const cached = [...state.cachedSessions.values()].sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name));
  for (const session of cached) if (!sessions.has(session.id) && !state.removedIds.has(session.id)) sessions.set(session.id, { ...session, source: session.cached ? 'cache' : 'temporary' });
  // Sort directory and cached entries together using the same start time shown
  // in the reader. Decode each filename once; unknown times go at the end.
  state.sessions = [...sessions.values()]
    .map((session) => ({ session, startedAt: sessionStartTime(session.name)?.getTime() ?? -1 }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ session }) => session);
  const currentDirectory = sessions.get(state.current?.id)?.directory;
  if (currentDirectory) state.current.directory = currentDirectory;
}

function renderLibrary() {
  $('#session-count').textContent = state.sessions.length;
  $('#session-list').replaceChildren();
  const visible = state.sessions.slice(0, state.libraryLimit);
  // Keep an older active file reachable after the batch, preserving date order
  // without rendering thousands of preceding rows.
  const current = state.sessions.find((session) => session.id === state.current?.id);
  if (current && !visible.includes(current)) visible.push(current);
  for (const session of visible) {
    const button = document.createElement('button');
    button.className = `session-item${state.current?.id === session.id ? ' active' : ''}`;
    button.title = session.name;
    button.setAttribute('aria-pressed', String(state.current?.id === session.id));
    const source = session.source === 'directory' ? '当前目录' : session.cached ? '本机缓存' : '本次打开';
    button.innerHTML = `${icon('file')}<span class="session-item-text"><span class="session-name">${escapeHTML(shortName(session.name))}</span><span class="session-meta">${source}<span>·</span>${bytes(session.size)}</span></span>${icon('chevron', 'session-chevron')}`;
    button.addEventListener('click', () => selectSession(session.id));
    $('#session-list').append(button);
  }
  const remaining = state.sessions.length - visible.length;
  $('#load-more-sessions').hidden = remaining <= 0;
  $('#load-more-sessions').textContent = `显示更多会话（剩余 ${remaining} 个）`;
  if (!state.sessions.length) $('#session-list').innerHTML = '<p class="muted sidebar-empty">打开一个导出文件，开始阅读。</p>';
}

function renderEmpty({ loading = false } = {}) {
  $('#reader-content').innerHTML = loading ? '<div class="empty-state"><span class="loader"></span><p>正在读取会话…</p></div>' : `
    <div class="empty-state"><div class="empty-icon">${icon('book')}</div><span class="eyebrow">A CLEARER VIEW OF YOUR WORK</span><h1>让每一段对话，清晰可读。</h1><p>打开 Codex CLI 导出的文件，<br />重新回到你的提问、探索和答案。</p><button class="primary-button" id="empty-open">${icon('plus')}打开导出文件</button><span class="empty-hint">也可以将文件拖到这里 · .md / .txt · 最大 20 MB</span><div class="export-hint"><span>在 Codex CLI 中输入</span><code>/export</code><span>保存会话，再到这里打开。</span></div></div>`;
  $('#empty-open')?.addEventListener('click', openFile);
}

function renderOutline() {
  const outline = $('#outline');
  outline.replaceChildren();
  if (!state.current) return;
  let index = 0;
  for (const message of state.current.conversation.messages) {
    if (!['user', 'assistant'].includes(message.role)) continue;
    const button = document.createElement('button');
    button.className = 'outline-item';
    button.dataset.target = message.id;
    button.dataset.role = message.role;
    button.dataset.final = String(message.isFinal);
    button.title = messagePreview(message.content, 180);
    button.innerHTML = `<span class="outline-number">${String(++index).padStart(2, '0')}</span><span class="outline-text"><span class="outline-role">${message.role === 'user' ? '你' : 'Codex'}${message.isFinal ? '<span class="outline-final">最后回复</span>' : ''}</span><span class="outline-preview">${escapeHTML(messagePreview(message.content))}</span></span>`;
    button.addEventListener('click', () => { revealMessage(message.id); setSidebar(false); });
    outline.append(button);
  }
}

function messageHeader(message, index) {
  const isUser = message.role === 'user';
  const name = isUser ? '你' : message.role === 'assistant' ? 'Codex' : '系统信息';
  return `<div class="message-header"><span class="avatar ${isUser ? 'user-avatar' : 'codex-avatar'}">${icon(isUser ? 'user' : 'code')}</span><strong>${name}</strong>${message.isFinal ? '<span class="final-badge" title="本轮最后一条 Codex 回复">本轮最后回复</span>' : ''}<span class="message-number">${String(index).padStart(2, '0')}</span><button class="icon-button small copy-message" data-copy-message="${message.id}" aria-label="复制${name}消息" title="复制消息 Markdown">${icon('copy')}</button></div>`;
}

function renderMessage(message, index) {
  const article = document.createElement('article');
  article.className = `message message-${message.role}${message.isFinal ? ' message-final' : ''}`;
  article.id = message.id;
  article.dataset.role = message.role;
  article.dataset.final = String(message.isFinal);
  article.innerHTML = messageHeader(message, index);
  const body = document.createElement('div');
  body.className = 'message-body markdown';
  body.dataset.searchContent = '';
  body.append(renderMarkdown(message.content));
  article.append(body);
  if (message.role === 'user' && (message.content.length > 800 || message.content.split('\n').length > 12)) {
    body.classList.add('is-collapsed');
    const expand = document.createElement('button');
    expand.className = 'expand-message';
    expand.setAttribute('aria-expanded', 'false');
    expand.innerHTML = `展开完整提问 ${icon('down')}`;
    expand.addEventListener('click', () => {
      const collapsed = body.classList.toggle('is-collapsed');
      expand.setAttribute('aria-expanded', String(!collapsed));
      expand.innerHTML = `${collapsed ? '展开完整提问' : '收起提问'} ${icon(collapsed ? 'down' : 'up')}`;
    });
    article.append(expand);
  }
  if (message.role === 'system') {
    const details = document.createElement('details');
    details.className = 'system-details';
    const summary = document.createElement('summary');
    summary.innerHTML = `${icon('info')}系统信息 ${icon('chevron')}`;
    details.append(summary, article);
    state.messageElements.set(message.id, article);
    return details;
  }
  state.messageElements.set(message.id, article);
  return article;
}

function loadActivity(details, message) {
  if (details.dataset.loaded) return;
  details.dataset.loaded = 'true';
  const wrapper = document.createElement('div');
  wrapper.className = 'activity-output';
  wrapper.innerHTML = `<div class="activity-output-toolbar"><span>原始执行输出 · ${message.activity.lineCount.toLocaleString()} 行</span><button class="text-button" data-copy-message="${message.id}">${icon('copy')}复制记录</button></div><pre data-search-content tabindex="0" aria-label="工具执行输出"></pre>`;
  wrapper.querySelector('pre').textContent = activityText(message.content);
  details.append(wrapper);
  if (state.query) highlightMatches(wrapper.querySelector('pre'), state.query);
}

function renderActivities(group) {
  const details = document.createElement('details');
  details.className = 'activity-group';
  details.id = group.id;
  const failures = group.messages.filter((message) => message.activity.status === 'error').length;
  details.innerHTML = `<summary class="activity-group-summary"><span class="activity-icon">${icon('terminal')}</span><span class="activity-group-label">${group.messages.length} 次工具活动</span><span class="activity-group-description">执行命令与输出</span>${failures ? `<span class="activity-errors" title="导出记录中有 ${failures} 次命令返回非零状态">${failures} 次非零退出</span>` : ''}<span class="activity-toggle-label">展开</span>${icon('chevron', 'disclosure-chevron')}</summary><div class="activity-list"></div>`;
  const list = details.querySelector('.activity-list');
  for (const message of group.messages) {
    const item = document.createElement('details');
    item.className = 'activity-item';
    item.id = message.id;
    const status = message.activity.status;
    item.innerHTML = `<summary><span class="activity-status ${status}">${status === 'success' ? icon('check') : status === 'error' ? icon('close') : icon('terminal')}</span><code class="activity-title">${escapeHTML(message.activity.title)}</code><span class="activity-lines">${message.activity.lineCount.toLocaleString()} 行</span>${icon('chevron', 'disclosure-chevron')}</summary>`;
    item.addEventListener('toggle', () => { if (item.open) loadActivity(item, message); });
    list.append(item);
    state.messageElements.set(message.id, item);
    state.groupElements.set(message.id, details);
  }
  details.addEventListener('toggle', () => {
    details.querySelector('.activity-toggle-label').textContent = details.open ? '收起' : '展开';
  });
  return details;
}

function renderConversation() {
  const session = state.current;
  const { conversation } = session;
  state.messageElements.clear();
  state.groupElements.clear();
  state.activeId = null;
  const content = $('#reader-content');
  const count = conversation.counts.user + conversation.counts.assistant;
  const title = conversation.title === 'Codex conversation' ? 'Codex 会话' : conversation.title;
  const startedAt = sessionStartTime(session.name);
  const startTime = document.createElement('span');
  startTime.className = 'conversation-start';
  startTime.title = startedAt ? '会话开始时间（本地时区）' : '原文件名未包含可识别的会话开始时间。';
  startTime.innerHTML = `${icon('clock')}${startedAt ? `<time datetime="${startedAt.toISOString()}">${formatSessionTime(startedAt)}</time>` : '开始时间未知'}`;
  content.innerHTML = `<section class="conversation-intro"><div class="intro-kicker"><span class="eyebrow">THE CONVERSATION</span><span class="file-format">MARKDOWN</span></div><div class="intro-title-row"><h1>${escapeHTML(title)}</h1><button class="jump-answer" id="jump-answer">跳到最后回复 ${icon('arrowDown')}</button></div><p class="conversation-filename" title="${escapeHTML(session.name)}">${icon('file')}<span>${escapeHTML(session.name)}</span></p><div class="conversation-stats"><span>${icon('chat')}<strong>${count}</strong> 条对话</span><i></i><span>${icon('terminal')}<strong>${conversation.counts.activity}</strong> 次工具活动</span><i></i><span>${bytes(session.size)}</span><span class="reading-note">一段思路，完整保留。</span></div></section><div class="conversation-messages" id="messages"></div><div class="conversation-end"><span></span>${icon('check')}已读到这段会话的末尾<span></span></div>`;
  $('.reading-note').before(startTime);
  const actions = document.createElement('div');
  actions.className = 'conversation-actions';
  const deleteButton = document.createElement('button');
  deleteButton.id = 'delete-session';
  deleteButton.className = 'delete-session';
  deleteButton.type = 'button';
  deleteButton.innerHTML = `${icon('trash')}删除会话`;
  deleteButton.addEventListener('click', openDeleteDialog);
  $('#jump-answer').before(actions);
  actions.append(deleteButton, $('#jump-answer'));
  const fragment = document.createDocumentFragment();
  let index = 0;
  for (const group of groupMessages(conversation.messages)) {
    fragment.append(group.type === 'activities' ? renderActivities(group) : renderMessage(group.messages[0], ++index));
  }
  $('#messages').append(fragment);
  $('#jump-answer').disabled = !conversation.counts.assistant;
  $('#jump-answer').addEventListener('click', () => {
    const last = conversation.messages.findLast((message) => message.role === 'assistant');
    if (last) revealMessage(last.id);
  });
  $('#footer-info').textContent = `${conversation.turns || 1} 轮对话 · ${count} 条消息 · ${conversation.lineCount.toLocaleString()} 行原文`;
  $('#download-file').disabled = false;
  document.title = `${shortName(session.name)} · Codex Reader`;
  renderOutline();
  applyView();
  $('#reader').scrollTop = 0;
  updateProgress();
}

function applyView() {
  updateViewControl();
  for (const [id, element] of state.messageElements) {
    if (element.classList.contains('activity-item')) {
      element.open = state.view === 'full';
      if (element.open) loadActivity(element, state.current.conversation.messages.find((message) => message.id === id));
    } else {
      const hidden = state.view === 'compact' && element.dataset.role !== 'user' && element.dataset.final !== 'true';
      (element.closest('.system-details') || element).hidden = hidden;
    }
    element.classList.remove('search-current');
  }
  for (const element of new Set(state.groupElements.values())) {
    element.hidden = state.view === 'compact';
    element.open = state.view === 'full';
  }
  for (const item of $('#outline').children) item.hidden = state.view === 'compact' && item.dataset.role !== 'user' && item.dataset.final !== 'true';
  if (state.query && state.matches.length) revealMessage(state.matches[state.matchIndex], { scroll: false, search: true });
  requestAnimationFrame(updateProgress);
}

function revealMessage(id, { scroll = true, search = false } = {}) {
  const element = state.messageElements.get(id);
  if (!element) return;
  element.hidden = false;
  const group = state.groupElements.get(id);
  if (group) { group.hidden = false; group.open = true; }
  if (element.matches('details')) {
    element.open = true;
    const message = state.current.conversation.messages.find((item) => item.id === id);
    loadActivity(element, message);
  }
  const system = element.closest('.system-details');
  if (system) { system.hidden = false; system.open = true; }
  const outline = $(`#outline [data-target="${id}"]`);
  if (outline) outline.hidden = false;
  if (search) {
    for (const previous of document.querySelectorAll('.search-current')) previous.classList.remove('search-current');
    element.classList.add('search-current');
    const expand = element.querySelector('.expand-message');
    if (expand?.getAttribute('aria-expanded') === 'false') expand.click();
    for (const body of element.querySelectorAll('[data-search-content]')) highlightMatches(body, state.query);
  }
  if (scroll) requestAnimationFrame(() => {
    const target = search ? element.querySelector('mark.search-highlight') || element : element;
    // Activity outputs have their own scroll area. Bring the matched text into view there first.
    const output = target.closest('.activity-output pre');
    if (output) output.scrollTop += target.getBoundingClientRect().top - output.getBoundingClientRect().top - 100;
    const anchor = output || target;
    const reader = $('#reader');
    reader.scrollTo({ top: reader.scrollTop + anchor.getBoundingClientRect().top - reader.getBoundingClientRect().top - 24, behavior: 'instant' });
    setActiveOutline(id);
  });
}

function clearSearch() {
  clearTimeout(searchTimeout);
  state.query = '';
  state.matches = [];
  state.matchIndex = -1;
  $('#search-input').value = '';
  $('#search-controls').hidden = true;
  $('#search-shortcut').hidden = false;
  for (const body of document.querySelectorAll('[data-search-content]')) highlightMatches(body, '');
  applyView();
}

function runSearch() {
  clearTimeout(searchTimeout);
  state.query = $('#search-input').value.trim();
  if (!state.query) return clearSearch();
  state.matches = findMatches(state.current?.conversation.messages || [], state.query);
  state.matchIndex = state.matches.length ? 0 : -1;
  $('#search-controls').hidden = false;
  $('#search-shortcut').hidden = true;
  for (const body of document.querySelectorAll('[data-search-content]')) highlightMatches(body, state.query);
  updateSearchCount();
  applyView();
  if (state.matches.length) revealMessage(state.matches[0], { search: true });
}

function updateSearchCount() {
  $('#search-count').textContent = state.matches.length ? `${state.matchIndex + 1} / ${state.matches.length} 条` : '无匹配';
  $('#search-prev').disabled = !state.matches.length;
  $('#search-next').disabled = !state.matches.length;
}

function nextMatch(step) {
  if ($('#search-input').value.trim() !== state.query) { runSearch(); return; }
  if (!state.matches.length) return;
  state.matchIndex = (state.matchIndex + step + state.matches.length) % state.matches.length;
  updateSearchCount();
  revealMessage(state.matches[state.matchIndex], { search: true });
}

async function restoreCache() {
  try {
    const index = await readCacheIndex();
    state.removedIds = new Set(index.removedIds);
    for (const [id, session] of state.cachedSessions) {
      if (session.cached || state.removedIds.has(id)) state.cachedSessions.delete(id);
    }
    for (const id of state.removedIds) temporaryTexts.delete(id);
    for (const session of index.sessions) state.cachedSessions.set(session.id, { ...session, cached: true });
    for (const link of index.directories) state.directoryLinks.set(link.name, link);
  } catch { warnCacheUnavailable(); }
}

async function rememberSession({ id, name, size, text, directory, restore = false }) {
  let result;
  let cached = true;
  const matches = [...state.cachedSessions.values()].filter((session) => sessionNames(session).includes(name));
  const memoryUpdate = planSessionUpdate({ id, name, size }, state.cachedSessions.get(id), matches);
  const importDirectory = restore ? state.directoryFiles.find((file) => file.name === name) : undefined;
  try {
    result = await saveCachedSession({ id, name, size, text, directory, importDirectory, restore });
    temporaryTexts.delete(id);
  } catch (error) {
    if (['SESSION_DELETED', 'SESSION_UPDATED'].includes(error.code)) throw error;
    if (matches.some((session) => session.cached && session.id !== id)) {
      throw new Error('缓存更新失败，原会话已保留。请检查浏览器存储权限或可用空间后重试。');
    }
    cached = false;
    result = memoryUpdate;
    temporaryTexts.set(id, text);
    warnCacheUnavailable();
    const observation = directory || importDirectory || (restore && state.directoryLinks.get(name));
    if (observation) result.directoryLinks.push({ ...observation, id, imported: !directory });
  }
  if (restore) state.removedIds.delete(id);
  // Another tab may already have replaced a hash still present in this page's
  // index. Reconcile local filename aliases as well as the transaction result.
  for (const oldId of new Set([...memoryUpdate.removedIds, ...result.removedIds])) {
    state.cachedSessions.delete(oldId);
    temporaryTexts.delete(oldId);
  }
  for (const session of [...memoryUpdate.updatedSessions, ...result.updatedSessions]) {
    state.cachedSessions.set(session.id, { ...session, cached: state.cachedSessions.get(session.id)?.cached ?? cached });
  }
  const metadata = { ...result.metadata, cached };
  state.cachedSessions.set(id, metadata);
  for (const link of result.directoryLinks) state.directoryLinks.set(link.name, link);
  return { ...result, metadata };
}

async function selectSession(id, { reloadDirectory = false, prepared, automatic = false } = {}) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  if (!automatic) state.selectionVersion++;
  const version = ++state.loadVersion;
  state.loadingId = id;
  clearError();
  setSidebar(false);
  setBusy(true);
  if (!state.current) renderEmpty({ loading: true });
  try {
    if (state.current?.id === id && !reloadDirectory) {
      const renamed = state.current.name !== session.name;
      if (renamed) clearSearch();
      state.current = { ...state.current, ...session, directory: session.directory };
      storage.set('last-directory', session.directory?.name || '');
      storage.set('last-session-name', session.name);
      if (renamed) { renderLibrary(); renderConversation(); }
      return;
    }
    let text = prepared?.text ?? temporaryTexts.get(id);
    let conversation = prepared?.conversation;
    let metadata = session;
    if (text === undefined && session.cached && !reloadDirectory) {
      try { text = await readCachedText(id); }
      catch (error) { if (!session.directory) throw error; warnCacheUnavailable(); }
    }
    if ((text === undefined || reloadDirectory) && session.directory) {
      const response = await fetch(`/api/session?name=${encodeURIComponent(session.directory.name)}`);
      if (!response.ok) throw new Error((await response.json()).error || '无法读取文件。');
      const buffer = await response.arrayBuffer();
      const contentId = await sessionId(buffer);
      if (version !== state.loadVersion) return;
      text = decodeFile(buffer);
      conversation = state.current?.id === contentId ? state.current.conversation : parseConversation(text);
      ({ metadata } = await rememberSession({ id: contentId, name: session.name, size: buffer.byteLength, text, directory: session.directory }));
      rebuildLibrary();
    }
    if (version !== state.loadVersion) return;
    if (text === undefined) throw new Error('本机缓存中的文件不可用，请重新打开原文件。');
    conversation ||= parseConversation(text);
    clearSearch();
    state.current = { ...metadata, name: session.name, directory: session.directory, text, conversation };
    storage.set('last-session-id', metadata.id);
    storage.set('last-session-name', session.name);
    storage.set('last-directory', session.directory?.name || '');
    renderLibrary();
    renderConversation();
  } catch (error) {
    if (version !== state.loadVersion) return;
    showError(error.message || '读取文件失败，请重试。');
    if (!state.current) renderEmpty();
  } finally {
    if (version === state.loadVersion) { state.loadingId = null; setBusy(false); }
  }
}

async function refreshDirectory({ initial = false } = {}) {
  const version = state.selectionVersion;
  $('#refresh-files').disabled = true;
  let directoryError;
  try {
    const [response] = await Promise.all([fetch('/api/sessions'), initial ? cacheReady : restoreCache()]);
    if (!response.ok) throw new Error('无法读取当前目录。你仍可以用“打开导出文件”选择文件。');
    const { sessions } = await response.json();
    state.directoryFiles = sessions;
  } catch (error) {
    directoryError = error.message || '无法读取当前目录。';
    await cacheReady;
  }
  try {
    if (state.removedIds.has(state.current?.id)) resetCurrentSession();
    rebuildLibrary();
    renderLibrary();
    // A slow directory scan must not replace a file the user just opened.
    if (version === state.selectionVersion) {
      const previousDirectory = state.current?.directory?.name || (initial ? storage.get('last-directory') : null);
      const previousName = state.current?.name || storage.get('last-session-name');
      const preferred = state.sessions.find((session) => previousDirectory && session.directory?.name === previousDirectory)
        || state.sessions.find((session) => session.name === previousName || sessionNames(session).includes(previousName))
        || state.sessions.find((session) => session.id === (state.current?.id || storage.get('last-session-id')))
        || state.sessions.find((session) => session.name === storage.get('last-session'))
        || state.sessions[0];
      if (preferred) {
        if (!initial || state.loadingId !== preferred.id) await selectSession(preferred.id, { reloadDirectory: !initial && Boolean(preferred.directory), automatic: true });
      } else if (!state.current) renderEmpty();
    }
    if (!initial) toast('文件列表已刷新');
    if (directoryError) showError(`${directoryError} 已缓存的会话仍可打开。`);
  } finally { $('#refresh-files').disabled = false; }
}

async function importFiles(fileList) {
  state.selectionVersion++;
  const version = ++state.loadVersion;
  state.loadingId = null;
  clearError();
  setBusy(true);
  await cacheReady;
  const errors = [];
  let first;
  let reused = 0;
  let updated = 0;
  for (const file of fileList) {
    try {
      if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error('请选择 .md、.markdown 或 .txt 文件。');
      if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 20 MB，请分段导出后读取。');
      const buffer = await file.arrayBuffer();
      const id = await sessionId(buffer);
      let existing = state.cachedSessions.get(id);
      if (!existing || existing.cached) {
        try {
          const cached = await findCachedSession(id);
          existing = cached ? { ...cached, cached: true } : undefined;
          if (existing) { state.cachedSessions.set(id, existing); state.removedIds.delete(id); }
        } catch { warnCacheUnavailable(); }
      }
      const text = decodeFile(buffer);
      const conversation = existing ? undefined : parseConversation(text);
      const result = await rememberSession({ id, name: file.name, size: file.size, text, restore: true });
      if (result.updated) updated++;
      if (result.reused) reused++;
      // A batch may contain several exports of the same filename. Select its
      // last successful version, whose cache entry survives the replacements.
      if (!first || first.name === file.name) first = { id, name: file.name, prepared: conversation ? { text, conversation } : undefined };
    } catch (error) { errors.push(`${file.name}：${error.message}`); }
  }
  rebuildLibrary();
  renderLibrary();
  if (version === state.loadVersion) {
    if (first) {
      await selectSession(first.id, { prepared: first.prepared, automatic: true });
      const saved = state.cachedSessions.get(first.id)?.cached;
      toast(updated ? saved ? '同名会话缓存已更新' : '同名会话已更新，本次仅在页面中保留' : reused === fileList.length ? '已复用本机已有会话' : saved ? '文件已打开并缓存到本机' : '文件已打开，本次仅在页面中保留');
    } else {
      setBusy(false);
      if (!state.current) renderEmpty();
    }
  }
  if (errors.length) showError(errors.join(' '));
}

let importQueue = Promise.resolve();
function queueImport(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  // FileList is live; snapshot and clear it before awaiting file IO.
  $('#file-input').value = '';
  importQueue = importQueue.then(() => importFiles(files)).catch((error) => { showError(error.message); setBusy(false); });
}

function resetCurrentSession() {
  clearSearch();
  state.current = null;
  state.messageElements.clear();
  state.groupElements.clear();
  state.activeId = null;
  $('#outline').replaceChildren();
  $('#download-file').disabled = true;
  $('#footer-info').textContent = 'Codex CLI /export · Markdown 阅读器';
  document.title = 'Codex · 会话阅读器';
  for (const key of ['last-session-id', 'last-session-name', 'last-directory', 'last-session']) storage.remove(key);
  renderEmpty();
  $('#reader').scrollTop = 0;
  updateProgress();
}

let deleteTarget = null;
let deleting = false;
function openDeleteDialog() {
  if (!state.current || $('#reader').getAttribute('aria-busy') === 'true') return;
  // Keep the confirmation tied to the displayed file even if a pending
  // directory scan completes while the dialog is open.
  state.selectionVersion++;
  const { id, name, cached, directory } = state.current;
  deleteTarget = { id, name, cached, directory };
  $('#delete-filename').textContent = name;
  $('#delete-error').hidden = true;
  setViewMenu(false);
  $('#delete-dialog').showModal();
  $('#cancel-delete').focus();
}

async function confirmDeleteSession() {
  if (!deleteTarget || deleting) return;
  const target = deleteTarget;
  const index = state.sessions.findIndex((session) => session.id === target.id);
  deleting = true;
  state.selectionVersion++;
  state.loadVersion++;
  state.loadingId = null;
  $('#delete-dialog').setAttribute('aria-busy', 'true');
  $('#cancel-delete').disabled = true;
  $('#confirm-delete').disabled = true;
  $('#confirm-delete').textContent = '正在删除…';
  $('#delete-error').hidden = true;
  setBusy(true);
  try {
    try { await deleteCachedSession(target.id, target.directory); }
    catch (error) {
      // An uncached import exists only in this page, so removing it from memory
      // is sufficient. Persisted files and directory exclusions must commit.
      if (target.cached || target.directory) throw error;
    }
    state.cachedSessions.delete(target.id);
    temporaryTexts.delete(target.id);
    state.removedIds.add(target.id);
    const wasCurrent = state.current?.id === target.id;
    if (wasCurrent) resetCurrentSession();
    rebuildLibrary();
    renderLibrary();
    $('#delete-dialog').close();
    if (wasCurrent) {
      const next = state.sessions[Math.max(0, Math.min(index, state.sessions.length - 1))];
      if (next) await selectSession(next.id, { automatic: true });
      $('#reader').focus({ preventScroll: true });
    }
    toast('会话已删除');
  } catch {
    $('#delete-error').textContent = '删除失败，会话仍保留。请检查浏览器存储权限后重试。';
    $('#delete-error').hidden = false;
  } finally {
    deleting = false;
    $('#delete-dialog').setAttribute('aria-busy', 'false');
    $('#cancel-delete').disabled = false;
    $('#confirm-delete').disabled = false;
    $('#confirm-delete').textContent = '确认删除';
    setBusy(false);
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Fall back on older browsers. */ }
  }
  const active = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.className = 'clipboard-field';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  active?.focus({ preventScroll: true });
  if (!copied) throw new Error('浏览器不允许复制，请手动选择文本复制。');
}

function setActiveOutline(id) {
  if (state.activeId === id) return;
  state.activeId = id;
  for (const item of $('#outline').children) {
    const active = item.dataset.target === id;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }
}

function updateProgress() {
  const reader = $('#reader');
  const distance = reader.scrollHeight - reader.clientHeight;
  $('#reading-progress').textContent = `${distance > 1 ? Math.round(reader.scrollTop / distance * 100) : state.current ? 100 : 0}%`;
  const top = reader.getBoundingClientRect().top;
  let active;
  for (const [id, element] of state.messageElements) {
    if (!element.matches('article') || element.hidden || element.closest('[hidden]')) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.top < top + reader.clientHeight * 0.45) active = id;
  }
  if (active) setActiveOutline(active);
}

$('#open-file').addEventListener('click', openFile);
$('.brand').addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  setSidebar(false);
  $('#reader').scrollTo({ top: 0, behavior: 'smooth' });
});
$('#file-input').addEventListener('change', (event) => queueImport(event.target.files));
$('#refresh-files').addEventListener('click', () => refreshDirectory());
$('#load-more-sessions').addEventListener('click', () => { state.libraryLimit += LIBRARY_PAGE_SIZE; renderLibrary(); });
$('#dismiss-error').addEventListener('click', clearError);
$('#cancel-delete').addEventListener('click', () => { if (!deleting) $('#delete-dialog').close(); });
$('#confirm-delete').addEventListener('click', confirmDeleteSession);
$('#delete-dialog').addEventListener('cancel', (event) => { if (deleting) event.preventDefault(); });
$('#delete-dialog').addEventListener('close', () => { deleteTarget = null; });
$('#theme-toggle').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; storage.set('theme', state.theme); updateTheme(); });
$('#menu-toggle').addEventListener('click', () => setSidebar(!$('#sidebar').classList.contains('is-open')));
$('#sidebar-backdrop').addEventListener('click', () => setSidebar(false));
$('#view-mode').addEventListener('click', () => setViewMenu($('#view-options').hidden));
$('#view-mode').addEventListener('keydown', (event) => {
  const open = !$('#view-options').hidden;
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    if (!open) setViewMenu(true);
    if (event.key === 'Home') focusViewOption(0);
    else if (event.key === 'End') focusViewOption(VIEW_MODES.length - 1);
    else if (open) focusViewOption(viewOptionIndex + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (open) chooseView(VIEW_MODES[viewOptionIndex].value);
    else setViewMenu(true);
  } else if (event.key === 'Escape' && open) {
    event.preventDefault();
    event.stopPropagation();
    setViewMenu(false);
  } else if (event.key === 'Tab') setViewMenu(false);
});
for (const [index, option] of [...$('#view-options').children].entries()) {
  // Keep keyboard focus on the combobox; aria-activedescendant identifies the
  // highlighted option for assistive technology and arrow-key navigation.
  option.addEventListener('pointerdown', (event) => event.preventDefault());
  option.addEventListener('pointerenter', () => focusViewOption(index));
  option.addEventListener('click', () => chooseView(option.dataset.view));
}
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.view-select')) setViewMenu(false); });
$('.view-select').addEventListener('focusout', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setViewMenu(false); });
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimeout); searchTimeout = setTimeout(runSearch, 160); });
$('#search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); }
  if (event.key === 'Escape') { event.preventDefault(); clearSearch(); $('#search-input').blur(); }
});
$('#search-clear').addEventListener('click', () => { clearSearch(); $('#search-input').focus(); });
$('#search-prev').addEventListener('click', () => nextMatch(-1));
$('#search-next').addEventListener('click', () => nextMatch(1));
$('#scroll-top').addEventListener('click', () => $('#reader').scrollTo({ top: 0, behavior: 'smooth' }));
$('#scroll-bottom').addEventListener('click', () => $('#reader').scrollTo({ top: $('#reader').scrollHeight, behavior: 'smooth' }));
$('#download-file').addEventListener('click', () => {
  if (!state.current) return;
  const url = URL.createObjectURL(new Blob([state.current.text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = state.current.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#reader-content').addEventListener('click', async (event) => {
  const code = event.target.closest('[data-copy-code]');
  const message = event.target.closest('[data-copy-message]');
  const source = event.target.closest('[data-source-path]');
  if (!code && !message && !source) return;
  try {
    const text = code ? code.closest('.code-block').querySelector('code').textContent : source ? source.dataset.sourcePath : state.current.conversation.messages.find((item) => item.id === message.dataset.copyMessage)?.content;
    if (text === undefined) return;
    await copyText(text);
    toast(source ? `路径已复制：${text}` : code ? '代码已复制' : '消息已复制');
  } catch (error) { showError(error.message); }
});
let scrollQueued = false;
$('#reader').addEventListener('scroll', () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { updateProgress(); scrollQueued = false; });
}, { passive: true });
window.addEventListener('resize', updateProgress);

document.addEventListener('keydown', (event) => {
  if ($('#delete-dialog').open) return;
  const editing = event.target.matches('input, textarea, select, [contenteditable="true"]');
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' || !editing && event.key === '/') {
    event.preventDefault(); $('#search-input').focus(); $('#search-input').select();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); openFile(); }
  if (event.key === 'Escape') { setSidebar(false); $('#drop-overlay').hidden = true; dragDepth = 0; }
});
document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  if ($('#delete-dialog').open) { event.preventDefault(); return; }
  event.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false;
});
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true;
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  if ($('#delete-dialog').open) { event.preventDefault(); return; }
  event.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true;
  queueImport(event.dataTransfer.files);
});

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$('#open-file kbd').textContent = isMac ? '⌘ O' : 'Ctrl O';
$('#search-shortcut').textContent = isMac ? '⌘ K' : 'Ctrl K';
updateTheme();
updateViewControl();
renderEmpty({ loading: true });
const cacheReady = restoreCache();
async function startReader() {
  const refresh = refreshDirectory({ initial: true });
  await cacheReady;
  // Restore the last cached conversation without waiting for a directory scan.
  if (state.loadVersion === 0) {
    rebuildLibrary();
    const lastName = storage.get('last-session-name');
    const last = state.sessions.find((session) => session.name === lastName || sessionNames(session).includes(lastName))
      || state.sessions.find((session) => session.id === storage.get('last-session-id'));
    if (last) {
      const directory = state.directoryLinks.get(storage.get('last-directory'));
      if (directory?.id === last.id) last.directory = directory;
      renderLibrary();
      await selectSession(last.id, { automatic: true });
    }
  }
  await refresh;
}
startReader().catch((error) => { showError(error.message); setBusy(false); });
