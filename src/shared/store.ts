// Armazenamento temporário das capturas em IndexedDB. Compartilhado entre o service worker
// (grava) e a aba de prévia (lê). chrome.storage.session tem teto de 10 MB, pequeno demais para
// PNGs grandes; já o IndexedDB guarda Blobs em disco. Capturas expiram (TTL) e só as mais
// recentes são mantidas.

const DB_NAME = "full-print";
const STORE = "captures";
const TTL_MS = 24 * 60 * 60 * 1000;
const KEEP_LAST = 5;

export interface CaptureMeta {
  id: string;
  createdAt: number;
  /** URL sem query/hash. */
  pageUrl: string;
  /** Pixels do PNG (dispositivo). */
  width: number;
  height: number;
  /** Tamanho da página em pixels CSS. */
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

export interface StoredCapture extends CaptureMeta {
  blob: Blob;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Falha ao abrir o armazenamento local."));
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("Falha no armazenamento local."));
        };
      }),
  );
}

export function saveCapture(capture: StoredCapture): Promise<IDBValidKey> {
  return run("readwrite", (store) => store.put(capture));
}

export async function loadCapture(id: string): Promise<StoredCapture | undefined> {
  return run<StoredCapture | undefined>("readonly", (store) => store.get(id));
}

// Remove capturas expiradas e excedentes. Nunca lança: é limpeza de melhor esforço.
export async function pruneCaptures(now = Date.now()): Promise<void> {
  try {
    const all = await run<StoredCapture[]>("readonly", (store) => store.getAll());
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    const stale = sorted.filter((c, index) => index >= KEEP_LAST || now - c.createdAt > TTL_MS);
    for (const capture of stale) {
      await run("readwrite", (store) => store.delete(capture.id));
    }
  } catch {
    // ignora
  }
}
