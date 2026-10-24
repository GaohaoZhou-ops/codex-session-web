// Keep the small library index separate from file bodies. Listing the library
// must never deserialize every conversation in IndexedDB.
const DATABASE = 'codex-reader-sessions';
let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 2);
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('sessions')) database.createObjectStore('sessions', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('contents')) database.createObjectStore('contents', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('directories')) database.createObjectStore('directories', { keyPath: 'name' });
        const sessions = request.transaction.objectStore('sessions');
        sessions.createIndex('names', 'names', { multiEntry: true });
        // Upgrade only the lightweight index. Existing file bodies stay intact.
        const directories = request.transaction.objectStore('directories').getAll();
        directories.onsuccess = () => {
          const aliases = new Map();
          for (const link of directories.result) {
            if (!aliases.has(link.id)) aliases.set(link.id, []);
            aliases.get(link.id).push(link.name);
          }
          const cursor = sessions.openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) return;
            if (!entry.value.deleted) entry.update({ ...entry.value, names: [...new Set([...sessionNames(entry.value), ...(aliases.get(entry.key) || [])])] });
            entry.continue();
          };
        };
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('请关闭其他阅读器页面后重试。'));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) { database.close(); return; }
        database.onversionchange = () => { database.close(); databasePromise = undefined; };
        resolve(database);
      };
    }).catch((error) => { databasePromise = undefined; throw error; });
  }
  return databasePromise;
}

export function sessionNames(session) {
  return session?.deleted ? [] : session?.names || (session?.name ? [session.name] : []);
}

export function planSessionUpdate({ id, name, size }, existing, matches) {
  const previous = matches.filter((session) => !session.deleted && session.id !== id);
  const live = existing && !existing.deleted ? existing : undefined;
  const metadata = live
    ? { ...live, name: previous.length ? name : live.name, names: [...new Set([...sessionNames(live), name])] }
    : { id, name, size, savedAt: Date.now(), names: [name] };
  const updatedSessions = [];
  const removedIds = [];
  for (const session of previous) {
    const names = sessionNames(session).filter((alias) => alias !== name);
    // A differently named file may still use these bytes. Retain its body and
    // remove only the alias being replaced; otherwise reclaim the old body.
    if (names.length) updatedSessions.push({ ...session, names, name: names.includes(session.name) ? session.name : names[0] });
    else removedIds.push(session.id);
  }
  return { metadata, updatedSessions, removedIds, updated: previous.length > 0, reused: Boolean(live), directoryLinks: [] };
}

function completed(transaction, result) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(result());
    transaction.onabort = () => reject(transaction.error || new Error('浏览器缓存操作失败。'));
    transaction.onerror = () => { /* The abort event reports the transaction failure. */ };
  });
}

export async function sessionId(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function readCacheIndex() {
  const database = await openDatabase();
  const transaction = database.transaction(['sessions', 'directories'], 'readonly');
  const sessions = transaction.objectStore('sessions').getAll();
  const directories = transaction.objectStore('directories').getAll();
  return completed(transaction, () => ({
    sessions: sessions.result.filter((session) => !session.deleted),
    removedIds: sessions.result.filter((session) => session.deleted).map((session) => session.id),
    directories: directories.result,
  }));
}

export async function findCachedSession(id) {
  const database = await openDatabase();
  const transaction = database.transaction('sessions', 'readonly');
  const request = transaction.objectStore('sessions').get(id);
  return completed(transaction, () => request.result?.deleted ? undefined : request.result);
}

export async function readCachedText(id) {
  const database = await openDatabase();
  const transaction = database.transaction('contents', 'readonly');
  const request = transaction.objectStore('contents').get(id);
  return completed(transaction, () => request.result?.text);
}

export async function saveCachedSession({ id, name, size, text, directory, importDirectory, restore = false }) {
  const database = await openDatabase();
  const transaction = database.transaction(['sessions', 'contents', 'directories'], 'readwrite');
  const sessions = transaction.objectStore('sessions');
  const contents = transaction.objectStore('contents');
  const directories = transaction.objectStore('directories');
  const existing = sessions.get(id);
  const matches = sessions.index('names').getAll(name);
  const previousDirectory = directories.get(name);
  let result;
  let blocked;
  previousDirectory.onsuccess = () => {
    // A delayed directory read (including one in another tab) must not recreate
    // a deleted session. Only an explicit file import restores it.
    if (existing.result?.deleted && !restore) { blocked = 'SESSION_DELETED'; return; }
    const link = previousDirectory.result;
    if (!restore && directory && link?.imported && link.id !== id && link.size === directory.size && link.modifiedAt === directory.modifiedAt) {
      blocked = 'SESSION_UPDATED';
      return;
    }
    result = planSessionUpdate({ id, name, size }, existing.result, matches.result);
    if (!result.reused) contents.add({ id, text });
    for (const oldId of result.removedIds) {
      sessions.delete(oldId);
      contents.delete(oldId);
    }
    for (const session of result.updatedSessions) sessions.put(session);
    sessions.put(result.metadata);
    const observation = directory || importDirectory || (restore && link);
    if (observation) {
      const updatedLink = { ...observation, id, imported: !directory };
      directories.put(updatedLink);
      result.directoryLinks.push(updatedLink);
    }
  };
  // A single transaction makes metadata + content atomic and prevents duplicate
  // bodies even when two tabs import the same bytes at the same time.
  await completed(transaction, () => undefined);
  if (blocked) throw Object.assign(new Error(blocked === 'SESSION_DELETED' ? '此会话已删除，请通过“打开导出文件”重新导入。' : '此会话已有更新的缓存，请刷新文件列表。'), { code: blocked });
  return result;
}

export async function deleteCachedSession(id, directory) {
  const database = await openDatabase();
  const transaction = database.transaction(['sessions', 'contents', 'directories'], 'readwrite');
  // Retain only the content ID and deletion flag. Existing directory links let
  // the library exclude this file version without touching the original file.
  transaction.objectStore('sessions').put({ id, deleted: true });
  transaction.objectStore('contents').delete(id);
  if (directory) {
    const directories = transaction.objectStore('directories');
    const existing = directories.get(directory.name);
    existing.onsuccess = () => {
      if (!existing.result || existing.result.id === id) directories.put({ ...directory, id });
    };
  }
  return completed(transaction, () => undefined);
}
