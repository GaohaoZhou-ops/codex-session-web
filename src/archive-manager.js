import { escapeHTML } from './markdown.js';
import { icon } from './icons.js';

export function setupArchiveManager({ trigger, getCurrentPath, onDelete, formatSize }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'archive-dialog';
  dialog.setAttribute('aria-labelledby', 'archive-manager-title');
  dialog.innerHTML = `<div class="archive-header"><div><h2 id="archive-manager-title">管理对话</h2><p>按归档日期管理会话文件</p></div><div class="archive-header-actions"><button class="icon-button" type="button" data-refresh aria-label="刷新归档列表" title="刷新归档列表">${icon('refresh')}</button><button class="icon-button" type="button" data-close aria-label="关闭对话管理">${icon('close')}</button></div></div><p class="archive-status" role="status"></p><p class="archive-error" role="alert" hidden></p><div class="archive-tree"></div>`;
  const confirmation = document.createElement('dialog');
  confirmation.className = 'delete-dialog archive-confirmation';
  confirmation.setAttribute('aria-labelledby', 'archive-delete-title');
  confirmation.setAttribute('aria-describedby', 'archive-delete-description archive-delete-path');
  confirmation.innerHTML = `<div class="delete-dialog-icon">${icon('trash')}</div><h2 id="archive-delete-title"></h2><p id="archive-delete-description"></p><p class="delete-filename" id="archive-delete-path"></p><p class="delete-error" role="alert" hidden></p><div class="delete-dialog-actions"><button type="button" class="cancel-delete">取消</button><button type="button" class="confirm-delete">永久删除</button></div>`;
  document.body.append(dialog, confirmation);
  const tree = dialog.querySelector('.archive-tree');
  const status = dialog.querySelector('.archive-status');
  const error = dialog.querySelector('.archive-error');
  const close = dialog.querySelector('[data-close]');
  let target;
  let deleting = false;
  let loadVersion = 0;

  function refreshHighlight() {
    const current = getCurrentPath();
    for (const row of tree.querySelectorAll('.archive-file')) {
      const active = row.dataset.path === current;
      row.classList.toggle('active', active);
      if (active) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      row.querySelector('.archive-current').hidden = !active;
    }
  }

  function requestDelete(item) {
    target = item;
    confirmation.querySelector('h2').textContent = item.day ? '删除整天归档？' : '删除归档文件？';
    const current = getCurrentPath();
    const includesCurrent = current === item.path || current?.startsWith(`${item.path}/`);
    confirmation.querySelector('#archive-delete-description').textContent = `${item.day ? `将永久删除 ${item.day} 的整个目录及其中所有文件` : '将永久删除此磁盘文件'}，并清理对应的本机缓存。此操作无法撤销。${includesCurrent ? '其中包含当前打开的会话。' : ''}`;
    confirmation.querySelector('#archive-delete-path').textContent = item.path;
    confirmation.querySelector('.delete-error').hidden = true;
    confirmation.showModal();
    confirmation.querySelector('.cancel-delete').focus();
  }

  async function load() {
    const version = ++loadVersion;
    error.hidden = true;
    tree.replaceChildren();
    status.textContent = '正在读取归档…';
    dialog.querySelector('[data-refresh]').disabled = true;
    try {
      const response = await fetch('/api/archive');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法读取归档目录。');
      if (version !== loadVersion || !dialog.open) return;
      const current = getCurrentPath();
      for (const [index, day] of result.days.entries()) {
        const group = document.createElement('details');
        group.className = 'archive-day';
        group.dataset.day = day.day;
        group.open = index === 0 || Boolean(current?.startsWith(`${day.path}/`));
        group.innerHTML = `<summary>${icon('chevron', 'archive-chevron')}${icon('folder')}<span class="archive-day-name">${escapeHTML(day.day)}</span><span class="count-badge">${day.files.length}</span><button type="button" class="archive-delete-day" aria-label="删除 ${escapeHTML(day.day)} 的全部文件">删除该日</button></summary><ul class="archive-files"></ul>`;
        group.querySelector('.archive-delete-day').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); requestDelete(day); });
        const list = group.querySelector('ul');
        for (const file of day.files) {
          const row = document.createElement('li');
          row.className = 'archive-file';
          row.dataset.path = file.path;
          row.innerHTML = `${icon('file')}<span class="archive-file-info"><span class="archive-file-name" title="${escapeHTML(file.path)}">${escapeHTML(file.name)}</span><span class="archive-file-meta">${formatSize(file.size)} <span class="archive-current" hidden>当前打开</span></span></span><button class="icon-button small archive-delete-file" type="button" aria-label="删除文件 ${escapeHTML(file.name)}（${escapeHTML(day.day)}）" title="删除文件">${icon('trash')}</button>`;
          row.querySelector('button').addEventListener('click', () => requestDelete(file));
          list.append(row);
        }
        if (!day.files.length) list.innerHTML = '<li class="archive-empty">此日期目录暂无会话文件。</li>';
        tree.append(group);
      }
      status.textContent = result.days.length ? `${result.days.length} 个归档日 · ${result.days.reduce((count, day) => count + day.files.length, 0)} 个会话文件` : '还没有归档会话，请先打开导出文件。';
      refreshHighlight();
    } catch (failure) {
      if (version !== loadVersion || !dialog.open) return;
      status.textContent = '';
      error.textContent = failure.message || '无法读取归档，请重试。';
      error.hidden = false;
    } finally {
      if (version === loadVersion) dialog.querySelector('[data-refresh]').disabled = false;
    }
  }

  trigger.addEventListener('click', () => { dialog.showModal(); close.focus(); load(); });
  close.addEventListener('click', () => { if (!deleting) dialog.close(); });
  dialog.querySelector('[data-refresh]').addEventListener('click', load);
  dialog.addEventListener('close', () => { loadVersion++; });
  for (const modal of [dialog, confirmation]) modal.addEventListener('cancel', (event) => { if (deleting) event.preventDefault(); });
  confirmation.querySelector('.cancel-delete').addEventListener('click', () => confirmation.close());
  confirmation.querySelector('.confirm-delete').addEventListener('click', async () => {
    if (deleting || !target) return;
    deleting = true;
    const item = target;
    const failure = confirmation.querySelector('.delete-error');
    failure.hidden = true;
    for (const button of confirmation.querySelectorAll('button')) button.disabled = true;
    confirmation.querySelector('.confirm-delete').textContent = '正在删除…';
    let deleted = false;
    try {
      const response = await fetch(`/api/archive?path=${encodeURIComponent(item.path)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '删除失败，请重试。');
      deleted = true;
      confirmation.close();
      await onDelete(item.path);
      await load();
      close.focus();
    } catch (reason) {
      const message = deleted ? error : failure;
      message.textContent = deleted ? `磁盘文件已删除，但列表更新失败：${reason.message}` : reason.message || '删除失败，请重试。';
      message.hidden = false;
    } finally {
      deleting = false;
      for (const button of confirmation.querySelectorAll('button')) button.disabled = false;
      confirmation.querySelector('.confirm-delete').textContent = '永久删除';
    }
  });
  return { refreshHighlight };
}
