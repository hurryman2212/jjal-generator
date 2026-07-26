'use strict';

(() => {
  const DB_NAME = 'speccard-web';
  const DB_VERSION = 1;
  const STORE_NAME = 'designs';
  let databasePromise;

  function openDatabase() {
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'file' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        reject(new Error('디자인 저장소를 열 수 없어요. 이 사이트의 다른 탭을 닫고 다시 시도해 주세요.'));
      };
    });

    return databasePromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('디자인 저장 작업이 취소됐어요.'));
    });
  }

  function safeName(name) {
    return String(name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 80) || 'untitled';
  }

  function fileNameOnly(file) {
    return String(file).split(/[\\/]/).pop() || '';
  }

  async function requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) return false;

    try {
      if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
      return navigator.storage.persist();
    } catch (_) {
      return false;
    }
  }

  async function list() {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const records = await requestResult(transaction.objectStore(STORE_NAME).getAll());

    return records
      .map((record) => ({
        file: record.file,
        name: record.name,
        mtime: record.mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  async function load(file) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const record = await requestResult(
      transaction.objectStore(STORE_NAME).get(fileNameOnly(file))
    );

    if (!record) throw new Error('저장된 디자인을 찾을 수 없어요.');
    return record.data;
  }

  async function save(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('저장할 디자인 데이터가 올바르지 않아요.');
    }

    const name = safeName(payload.name || 'untitled');
    const existingFile = payload.file ? fileNameOnly(payload.file) : '';
    const file = existingFile || `${name}-${Date.now()}.json`;
    const record = {
      file,
      name,
      mtime: Date.now(),
      data: JSON.parse(JSON.stringify(payload)),
    };

    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    await requestResult(transaction.objectStore(STORE_NAME).put(record));
    await done;
    void requestPersistentStorage();

    return { file, name };
  }

  async function remove(file) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    await requestResult(
      transaction.objectStore(STORE_NAME).delete(fileNameOnly(file))
    );
    await done;
  }

  window.designDb = Object.freeze({
    list,
    load,
    save,
    remove,
  });
})();
