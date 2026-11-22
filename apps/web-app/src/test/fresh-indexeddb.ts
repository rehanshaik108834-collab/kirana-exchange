import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { closeDbForTests } from '../lib/db';

/** Give each test an empty IndexedDB and drop the app's cached connection. */
export async function freshIndexedDb(): Promise<void> {
  await closeDbForTests();
  globalThis.indexedDB = new IDBFactory();
}
