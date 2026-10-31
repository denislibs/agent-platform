import { fileStoreContract, InMemoryFileStore } from '@agent/testing';

fileStoreContract('in-memory', async () => ({ store: new InMemoryFileStore(), close: async () => {} }));
