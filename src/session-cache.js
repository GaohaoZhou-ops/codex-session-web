// Keep the small library index separate from file bodies. Listing the library
// must never deserialize every conversation in IndexedDB.
const DATABASE = 'codex-reader-sessions';
let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('sessions', { keyPath: 'id' });
        database.createObjectStore('contents', { keyPath: 'id' });
        database.createObjectStore('directories', { keyPath: 'name' });
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

export async function saveCachedSession({ id, name, size, text, directory, restore = false }) {
  const database = await openDatabase();
  const transaction = database.transaction(['sessions', 'contents', 'directories'], 'readwrite');
  const sessions = transaction.objectStore('sessions');
  const existing = sessions.get(id);
  let metadata;
  existing.onsuccess = () => {
    // A delayed directory read (including one in another tab) must not recreate
    // a deleted session. Only an explicit file import restores it.
    if (existing.result?.deleted && !restore) return;
    metadata = existing.result;
    if (!metadata || metadata.deleted) {
      metadata = { id, name, size, savedAt: Date.now() };
      sessions.put(metadata);
      transaction.objectStore('contents').add({ id, text });
    }
    if (directory) transaction.objectStore('directories').put({ ...directory, id });
  };
  // A single transaction makes metadata + content atomic and prevents duplicate
  // bodies even when two tabs import the same bytes at the same time.
  await completed(transaction, () => undefined);
  if (!metadata) throw Object.assign(new Error('此会话已删除，请通过“打开导出文件”重新导入。'), { code: 'SESSION_DELETED' });
  return metadata;
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
