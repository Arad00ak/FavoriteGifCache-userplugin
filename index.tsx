/*
 * Vencord / Equicord userplugin — FavoriteGifCache
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Single-file install. Source: https://github.com/Arad00ak/FavoriteGifCache
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";
import type { PluginNative } from "@utils/types";
import { Menu, Toasts, useEffect, useState } from "@webpack/common";

const DEFAULT_MAX_ENTRIES = 500;
/** Soft size budget shown in settings and enforced with the entry cap. */
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

interface CacheMeta {
    key: string;
    useCount: number;
    lastUsed: number;
    size: number;
    mimeType: string;
    createdAt: number;
}

interface CacheEntry extends CacheMeta {
    data: Uint8Array;
}

interface CacheCoreOptions {
    maxEntries?: number;
    maxBytes?: number;
    now?: () => number;
}

interface PutOptions {
    /**
     * When false (default), refuse to store a new key if the cache is already full.
     * Stops scroll/prefetch from kicking out stuff just to make room for something else.
     * When true, drop the least-used entry (prefer ones not marked protected).
     */
    allowEvict?: boolean;
}

interface PutResult {
    stored: boolean;
    evictedKeys: string[];
    /** true when we skipped insert because the cache was full and eviction was off */
    skippedFull?: boolean;
}

class GifCacheCore {
    private readonly entries = new Map<string, CacheEntry>();
    private maxEntries: number;
    private maxBytes: number;
    private totalBytes = 0;
    private readonly now: () => number;
    /** Keys we try not to evict (usually still in Discord favorites). */
    private protectedKeys = new Set<string>();

    constructor(options: CacheCoreOptions = {}) {
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
        this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
        this.now = options.now ?? (() => Date.now());
    }

    getMaxEntries() {
        return this.maxEntries;
    }

    setMaxEntries(n: number) {
        this.maxEntries = Math.max(1, n);
        return this.enforceCap();
    }

    getMaxBytes() {
        return this.maxBytes;
    }

    setMaxBytes(n: number) {
        this.maxBytes = n > 0 ? n : Number.POSITIVE_INFINITY;
        return this.enforceCap();
    }

    setProtectedKeys(keys: Iterable<string>) {
        this.protectedKeys = new Set(keys);
    }

    getProtectedKeys(): string[] {
        return [...this.protectedKeys];
    }

    size() {
        return this.entries.size;
    }

    bytes() {
        return this.totalBytes;
    }

    keys() {
        return [...this.entries.keys()];
    }

    has(key: string) {
        return this.entries.has(key);
    }

    get(key: string): CacheEntry | null {
        const entry = this.entries.get(key);
        if (!entry) return null;

        entry.useCount += 1;
        entry.lastUsed = this.now();

        return { ...entry, data: entry.data.slice() };
    }

    peek(key: string): CacheEntry | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        return { ...entry, data: entry.data.slice() };
    }

    getMeta(key: string): CacheMeta | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        const { data: _d, ...meta } = entry;
        return { ...meta };
    }

    listMeta(): CacheMeta[] {
        return [...this.entries.values()].map(({ data: _d, ...meta }) => ({ ...meta }));
    }

    /**
     * Store bytes for a key.
     * Overwrite of an existing key never grows the entry count.
     * New keys only push others out when allowEvict is true.
     */
    put(
        key: string,
        data: Uint8Array,
        mimeType = "application/octet-stream",
        options: PutOptions = {},
    ): PutResult {
        if (!key) return { stored: false, evictedKeys: [] };

        const allowEvict = options.allowEvict === true;
        const payload = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
        const size = payload.byteLength;
        const evictedKeys: string[] = [];

        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= existing.size;
            this.entries.delete(key);
        }

        if (size > this.maxBytes && this.maxBytes !== Number.POSITIVE_INFINITY) {
            return { stored: false, evictedKeys };
        }

        const needsSlot = !existing;
        const overCount = () => this.entries.size >= this.maxEntries && needsSlot
            || (existing ? this.entries.size > this.maxEntries : this.entries.size >= this.maxEntries);
        // after deleting existing, size is entries without this key
        while (
            (needsSlot && this.entries.size >= this.maxEntries)
            || this.totalBytes + size > this.maxBytes
        ) {
            if (!allowEvict) {
                // put existing back if we stripped it for rewrite and can't finish
                if (existing) {
                    this.entries.set(existing.key, existing);
                    this.totalBytes += existing.size;
                }
                return { stored: false, evictedKeys, skippedFull: true };
            }
            const victim = this.pickVictim(key);
            if (!victim) break;
            this.entries.delete(victim.key);
            this.totalBytes -= victim.size;
            evictedKeys.push(victim.key);
        }

        if (
            (needsSlot && this.entries.size >= this.maxEntries)
            || this.totalBytes + size > this.maxBytes
        ) {
            if (existing) {
                this.entries.set(existing.key, existing);
                this.totalBytes += existing.size;
            }
            return { stored: false, evictedKeys, skippedFull: true };
        }

        const t = this.now();
        const entry: CacheEntry = {
            key,
            data: payload,
            size,
            mimeType: mimeType || "application/octet-stream",
            useCount: existing?.useCount ?? 0,
            lastUsed: t,
            createdAt: existing?.createdAt ?? t,
        };

        this.entries.set(key, entry);
        this.totalBytes += size;
        return { stored: true, evictedKeys };
    }

    delete(key: string) {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.entries.delete(key);
        this.totalBytes -= entry.size;
        return true;
    }

    clear() {
        this.entries.clear();
        this.totalBytes = 0;
    }

    /** Load from disk without touching use counts. */
    loadEntry(entry: CacheEntry) {
        const payload = entry.data instanceof Uint8Array
            ? entry.data.slice()
            : new Uint8Array(entry.data);
        const prev = this.entries.get(entry.key);
        if (prev) {
            this.totalBytes -= prev.size;
            this.entries.delete(entry.key);
        }
        const next: CacheEntry = {
            key: entry.key,
            data: payload,
            size: payload.byteLength,
            mimeType: entry.mimeType || "application/octet-stream",
            useCount: entry.useCount ?? 0,
            lastUsed: entry.lastUsed ?? this.now(),
            createdAt: entry.createdAt ?? this.now(),
        };
        this.entries.set(next.key, next);
        this.totalBytes += next.size;
    }

    /**
     * Least-used first, then oldest lastUsed.
     * Prefer kicking unprotected keys (not in the current favorites set).
     */
    pickVictim(exceptKey?: string): CacheEntry | null {
        let bestUnprotected: CacheEntry | null = null;
        let bestAny: CacheEntry | null = null;

        for (const entry of this.entries.values()) {
            if (exceptKey && entry.key === exceptKey) continue;

            if (!this.protectedKeys.has(entry.key)) {
                if (!bestUnprotected || this.isWorse(entry, bestUnprotected)) {
                    bestUnprotected = entry;
                }
            }
            if (!bestAny || this.isWorse(entry, bestAny)) {
                bestAny = entry;
            }
        }

        return bestUnprotected ?? bestAny;
    }

    private isWorse(a: CacheEntry, b: CacheEntry) {
        if (a.useCount !== b.useCount) return a.useCount < b.useCount;
        if (a.lastUsed !== b.lastUsed) return a.lastUsed < b.lastUsed;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
        return a.key < b.key;
    }

    private enforceCap(): string[] {
        const evicted: string[] = [];
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            const victim = this.pickVictim();
            if (!victim) break;
            this.entries.delete(victim.key);
            this.totalBytes -= victim.size;
            evicted.push(victim.key);
        }
        return evicted;
    }
}

interface StorageBackend {
    readonly name: string;
    open(): Promise<void>;
    close(): Promise<void>;
    getAll(): Promise<CacheEntry[]>;
    get(key: string): Promise<CacheEntry | null>;
    put(entry: CacheEntry): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    deleteMany(keys: string[]): Promise<void>;
}

// Stable name so closing Discord does not wipe the DB
const DB_NAME = "FavoriteGifCache";
const DB_VERSION = 1;
const STORE = "gifs";

function toEntry(raw: any): CacheEntry {
    let data: Uint8Array;
    if (raw.data instanceof Uint8Array) {
        data = raw.data;
    } else if (raw.data instanceof ArrayBuffer) {
        data = new Uint8Array(raw.data);
    } else if (ArrayBuffer.isView(raw.data)) {
        data = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
    } else {
        data = new Uint8Array(0);
    }

    return {
        key: String(raw.key),
        data,
        size: typeof raw.size === "number" ? raw.size : data.byteLength,
        mimeType: raw.mimeType || "application/octet-stream",
        useCount: Number(raw.useCount) || 0,
        lastUsed: Number(raw.lastUsed) || 0,
        createdAt: Number(raw.createdAt) || 0,
    };
}

/** In-memory backend for tests / environments without IDB. */
class MemoryStorageBackend implements StorageBackend {
    readonly name = "memory";
    private map = new Map<string, CacheEntry>();

    async open() {}
    async close() {}

    async getAll() {
        return [...this.map.values()].map(e => ({ ...e, data: e.data.slice() }));
    }

    async get(key: string) {
        const e = this.map.get(key);
        return e ? { ...e, data: e.data.slice() } : null;
    }

    async put(entry: CacheEntry) {
        this.map.set(entry.key, {
            ...entry,
            data: entry.data.slice(),
            size: entry.data.byteLength,
        });
    }

    async delete(key: string) {
        this.map.delete(key);
    }

    async clear() {
        this.map.clear();
    }

    async deleteMany(keys: string[]) {
        for (const k of keys) this.map.delete(k);
    }
}

/**
 * IndexedDB store. Lives in the Discord profile, survives restarts.
 * Plugin disable only drops the in-memory layer; this stays put.
 */
class IndexedDBStorageBackend implements StorageBackend {
    readonly name = "indexeddb";
    private db: IDBDatabase | null = null;

    async open() {
        if (typeof indexedDB === "undefined") {
            throw new Error("IndexedDB unavailable");
        }
        if (this.db) return;

        this.db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: "key" });
                    store.createIndex("useCount", "useCount", { unique: false });
                    store.createIndex("lastUsed", "lastUsed", { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    async close() {
        this.db?.close();
        this.db = null;
    }

    private store(mode: IDBTransactionMode) {
        if (!this.db) throw new Error("IndexedDB not open");
        return this.db.transaction(STORE, mode).objectStore(STORE);
    }

    async getAll() {
        await this.open();
        return new Promise<CacheEntry[]>((resolve, reject) => {
            const req = this.store("readonly").getAll();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(((req.result as any[]) || []).map(toEntry));
        });
    }

    async get(key: string) {
        await this.open();
        return new Promise<CacheEntry | null>((resolve, reject) => {
            const req = this.store("readonly").get(key);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result ? toEntry(req.result) : null);
        });
    }

    async put(entry: CacheEntry) {
        await this.open();
        const record = {
            key: entry.key,
            data: entry.data.slice().buffer,
            size: entry.data.byteLength,
            mimeType: entry.mimeType,
            useCount: entry.useCount,
            lastUsed: entry.lastUsed,
            createdAt: entry.createdAt,
        };
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").put(record);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async delete(key: string) {
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").delete(key);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async clear() {
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").clear();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async deleteMany(keys: string[]) {
        if (!keys.length) return;
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const tx = this.db!.transaction(STORE, "readwrite");
            const store = tx.objectStore(STORE);
            for (const k of keys) store.delete(k);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

/**
 * Folder on disk via plugin native.ts (desktop only).
 * Each entry is a blob file + meta.json row.
 */
class FileStorageBackend implements StorageBackend {
    readonly name = "filesystem";
    constructor(
        private readonly dir: string,
        private readonly api: {
            ensureCacheDir(dir: string): Promise<unknown>;
            loadAllEntries(dir: string): Promise<Array<{
                key: string;
                data: ArrayBuffer;
                mimeType: string;
                useCount: number;
                lastUsed: number;
                createdAt: number;
                size: number;
            }>>;
            putEntry(dir: string, entry: {
                key: string;
                data: ArrayBuffer;
                mimeType: string;
                useCount: number;
                lastUsed: number;
                createdAt: number;
                size: number;
            }): Promise<unknown>;
            deleteEntry(dir: string, key: string): Promise<unknown>;
            deleteEntries(dir: string, keys: string[]): Promise<unknown>;
            clearCacheDir(dir: string): Promise<unknown>;
        },
    ) {}

    get directory() {
        return this.dir;
    }

    async open() {
        await this.api.ensureCacheDir(this.dir);
    }

    async close() {}

    async getAll(): Promise<CacheEntry[]> {
        const rows = await this.api.loadAllEntries(this.dir);
        return rows.map(r => toEntry({
            key: r.key,
            data: r.data,
            mimeType: r.mimeType,
            useCount: r.useCount,
            lastUsed: r.lastUsed,
            createdAt: r.createdAt,
            size: r.size,
        }));
    }

    async get(key: string) {
        const all = await this.getAll();
        return all.find(e => e.key === key) ?? null;
    }

    async put(entry: CacheEntry) {
        const copy = entry.data.slice();
        await this.api.putEntry(this.dir, {
            key: entry.key,
            data: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
            mimeType: entry.mimeType,
            useCount: entry.useCount,
            lastUsed: entry.lastUsed,
            createdAt: entry.createdAt,
            size: entry.data.byteLength,
        });
    }

    async delete(key: string) {
        await this.api.deleteEntry(this.dir, key);
    }

    async clear() {
        await this.api.clearCacheDir(this.dir);
    }

    async deleteMany(keys: string[]) {
        if (!keys.length) return;
        await this.api.deleteEntries(this.dir, keys);
    }
}

function createDefaultBackend(): StorageBackend {
    if (typeof indexedDB !== "undefined") return new IndexedDBStorageBackend();
    return new MemoryStorageBackend();
}

function createBackendForPath(
    cacheDir: string | undefined | null,
    nativeApi: FileStorageBackend["api"] | null,
): StorageBackend {
    const dir = (cacheDir || "").trim();
    if (dir && nativeApi) {
        return new FileStorageBackend(dir, nativeApi);
    }
    return createDefaultBackend();
}

type { CacheEntry, CacheMeta, PutOptions, PutResult, StorageBackend };

interface FavoriteGifCacheOptions extends CacheCoreOptions {
    backend?: StorageBackend;
    /**
     * When false, put(..., { allowEvict: true }) will not drop old entries.
     * New items are refused if the cache is full.
     */
    smartEviction?: boolean;
}

interface BlobUrlOptions {
    /** Bump use stats (default true on display, false when just warming). */
    bumpUsage?: boolean;
}

class FavoriteGifCache {
    private readonly core: GifCacheCore;
    private readonly backend: StorageBackend;
    private smartEviction: boolean;
    private ready: Promise<void> | null = null;
    private initDone = false;
    private blobUrls = new Map<string, string>();
    private metaPersistQueue = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(options: FavoriteGifCacheOptions = {}) {
        this.core = new GifCacheCore(options);
        this.backend = options.backend ?? createDefaultBackend();
        this.smartEviction = options.smartEviction !== false;
    }

    get backendName() {
        return this.backend.name;
    }

    getSmartEviction() {
        return this.smartEviction;
    }

    setSmartEviction(enabled: boolean) {
        this.smartEviction = enabled;
    }

    isInitialized() {
        return this.initDone;
    }

    async init() {
        if (!this.ready) {
            this.ready = (async () => {
                await this.backend.open();
                const all = await this.backend.getAll();
                for (const entry of all) this.core.loadEntry(entry);

                // only trim if the user lowered the setting since last run
                const before = new Set(this.core.keys());
                const removed = this.core.setMaxEntries(this.core.getMaxEntries());
                const gone = removed.length
                    ? removed
                    : [...before].filter(k => !this.core.has(k));
                if (gone.length) await this.backend.deleteMany(gone);

                // rebuild blob: urls from disk so the picker can paint offline
                this.warmAllBlobUrls();
                this.initDone = true;
            })();
        }
        await this.ready;
    }

    getMaxEntries() {
        return this.core.getMaxEntries();
    }

    getMaxBytes() {
        return this.core.getMaxBytes();
    }

    async setMaxEntries(n: number) {
        await this.init();
        const before = new Set(this.core.keys());
        this.core.setMaxEntries(n);
        const removed = [...before].filter(k => !this.core.has(k));
        if (removed.length) {
            await this.backend.deleteMany(removed);
            for (const k of removed) this.revokeBlob(k);
        }
    }

    async setMaxBytes(n: number) {
        await this.init();
        const before = new Set(this.core.keys());
        this.core.setMaxBytes(n);
        const removed = [...before].filter(k => !this.core.has(k));
        if (removed.length) {
            await this.backend.deleteMany(removed);
            for (const k of removed) this.revokeBlob(k);
        }
    }

    /** Tell the cache which keys are still Discord favorites (eviction avoids these). */
    setProtectedKeys(keys: Iterable<string>) {
        this.core.setProtectedKeys(keys);
    }

    size() {
        return this.core.size();
    }

    bytes() {
        return this.core.bytes();
    }

    has(key: string) {
        return this.core.has(key);
    }

    keys() {
        return this.core.keys();
    }

    listMeta() {
        return this.core.listMeta();
    }

    async get(key: string): Promise<CacheEntry | null> {
        await this.init();
        const entry = this.core.get(key);
        if (!entry) return null;
        await this.backend.put(entry);
        return entry;
    }

    async peek(key: string) {
        await this.init();
        return this.core.peek(key);
    }

    peekSync(key: string) {
        return this.core.peek(key);
    }

    getMetaSync(key: string) {
        return this.core.getMeta(key);
    }

    touchSync(key: string) {
        const entry = this.core.get(key);
        if (!entry) return false;
        this.scheduleMetaPersist(entry);
        return true;
    }

    /**
     * Write media. By default will not kick anything out if full (scroll-safe).
     * Pass allowEvict: true only when intentionally reclaiming space.
     */
    async put(
        key: string,
        data: Uint8Array,
        mimeType = "application/octet-stream",
        options: PutOptions = {},
    ): Promise<PutResult> {
        await this.init();
        const allowEvict = this.smartEviction && options.allowEvict === true;
        const result = this.core.put(key, data, mimeType, { allowEvict });

        if (result.evictedKeys.length) {
            await this.backend.deleteMany(result.evictedKeys);
            for (const k of result.evictedKeys) this.revokeBlob(k);
        }

        if (result.stored) {
            const stored = this.core.peek(key);
            if (stored) {
                await this.backend.put(stored);
                this.revokeBlob(key);
                this.ensureBlobUrlSync(key, { bumpUsage: false });
            }
        }

        return result;
    }

    async delete(key: string) {
        await this.init();
        const ok = this.core.delete(key);
        if (ok) {
            await this.backend.delete(key);
            this.revokeBlob(key);
        }
        return ok;
    }

    /**
     * Drop keys that are no longer favorites. Frees slots without thrashing still-favorited media.
     * Does not wipe the whole cache.
     */
    async pruneNotIn(keepKeys: Iterable<string>) {
        await this.init();
        const keep = new Set(keepKeys);
        const drop: string[] = [];
        for (const key of this.core.keys()) {
            if (!keep.has(key)) drop.push(key);
        }
        for (const key of drop) {
            this.core.delete(key);
            this.revokeBlob(key);
        }
        if (drop.length) await this.backend.deleteMany(drop);
        return drop;
    }

    async clear() {
        await this.init();
        for (const k of [...this.blobUrls.keys()]) this.revokeBlob(k);
        this.core.clear();
        await this.backend.clear();
    }

    ensureBlobUrlSync(key: string, opts: BlobUrlOptions = {}): string | null {
        if (!key) return null;
        if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
            return null;
        }

        const bump = opts.bumpUsage !== false;
        const existing = this.blobUrls.get(key);
        if (existing) {
            if (bump) this.touchSync(key);
            return existing;
        }

        const entry = bump ? this.core.get(key) : this.core.peek(key);
        if (!entry) return null;
        if (bump) this.scheduleMetaPersist(entry);

        try {
            const copy = entry.data.slice();
            const blob = new Blob([copy], { type: entry.mimeType || "image/gif" });
            const url = URL.createObjectURL(blob);
            this.blobUrls.set(key, url);
            return url;
        } catch {
            return null;
        }
    }

    resolveDisplayUrlSync(remoteUrl: string): string | null {
        if (!remoteUrl || remoteUrl.startsWith("blob:") || remoteUrl.startsWith("data:")) {
            return remoteUrl || null;
        }

        const candidates = [remoteUrl];
        try {
            const u = new URL(remoteUrl);
            if (
                u.hostname.includes("tenor.com")
                || u.hostname.includes("giphy.com")
                || u.hostname.includes("discordapp")
                || u.hostname.includes("discord.com")
            ) {
                candidates.unshift(`${u.origin}${u.pathname}`);
            }
        } catch {
            // keep raw
        }

        for (const key of candidates) {
            const hot = this.blobUrls.get(key);
            if (hot) {
                this.touchSync(key);
                return hot;
            }
        }

        for (const key of candidates) {
            const created = this.ensureBlobUrlSync(key, { bumpUsage: true });
            if (created) return created;
        }

        return null;
    }

    warmAllBlobUrls(keys?: string[]) {
        const list = keys ?? this.core.keys();
        let n = 0;
        for (const key of list) {
            if (this.ensureBlobUrlSync(key, { bumpUsage: false })) n += 1;
        }
        return n;
    }

    async getBlobUrl(key: string) {
        await this.init();
        return this.ensureBlobUrlSync(key, { bumpUsage: true });
    }

    getCachedBlobUrl(key: string) {
        return this.blobUrls.get(key);
    }

    private scheduleMetaPersist(entry: CacheEntry) {
        const prev = this.metaPersistQueue.get(entry.key);
        if (prev) clearTimeout(prev);

        const t = setTimeout(() => {
            this.metaPersistQueue.delete(entry.key);
            const latest = this.core.peek(entry.key);
            if (!latest) return;
            void this.backend.put(latest).catch(() => {});
        }, 50);
        this.metaPersistQueue.set(entry.key, t);
    }

    private revokeBlob(key: string) {
        const url = this.blobUrls.get(key);
        if (url && typeof URL !== "undefined" && URL.revokeObjectURL) {
            try {
                URL.revokeObjectURL(url);
            } catch {
                // ignore
            }
        }
        this.blobUrls.delete(key);
    }

    getCoreForTests() {
        return this.core;
    }
}

function createFavoriteGifCache(options: FavoriteGifCacheOptions = {}) {
    return new FavoriteGifCache({
        maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        backend: options.backend,
        now: options.now,
        smartEviction: options.smartEviction,
    });
}

interface FavoriteGifRef {
    url: string;
    src: string;
    width?: number;
    height?: number;
    format?: number;
    /** Discord favorite order — higher usually means newer / more recent. */
    order?: number;
}

type WebpackFind = (filter: (m: any) => boolean) => any;

function getWebpackFind(): WebpackFind | null {
    try {
        const w = (globalThis as any).Vencord?.Webpack?.find
            ?? (globalThis as any).Equicord?.Webpack?.find;
        if (typeof w === "function") return w;
    } catch {
        // ignore
    }
    return null;
}

/** Pull favorite gif urls from Discord's frecency settings blob. */
function getFavoriteGifRefsFromFrecency(): FavoriteGifRef[] {
    try {
        const find = getWebpackFind();
        if (!find) return [];

        const FrecencyUserSettings = find(
            (m: any) => typeof m?.ProtoClass?.typeName === "string"
                && m.ProtoClass.typeName.endsWith(".FrecencyUserSettings"),
        );
        if (!FrecencyUserSettings?.getCurrentValue) return [];

        const value = FrecencyUserSettings.getCurrentValue();
        const gifs = value?.favoriteGifs?.gifs;
        if (!gifs || typeof gifs !== "object") return [];

        const out: FavoriteGifRef[] = [];
        for (const [key, meta] of Object.entries(gifs as Record<string, any>)) {
            const url = typeof meta?.url === "string" ? meta.url : key;
            const src = typeof meta?.src === "string" ? meta.src : url;
            if (!url && !src) continue;
            out.push({
                url: url || src,
                src: src || url,
                width: meta?.width,
                height: meta?.height,
                format: meta?.format,
                order: meta?.order,
            });
        }
        return sortFavoritesNewestFirst(out);
    } catch {
        return [];
    }
}

/** Newest first (higher `order` first). Missing order sorts last. */
function sortFavoritesNewestFirst(refs: FavoriteGifRef[]): FavoriteGifRef[] {
    return [...refs].sort((a, b) => {
        const ao = typeof a.order === "number" ? a.order : Number.NEGATIVE_INFINITY;
        const bo = typeof b.order === "number" ? b.order : Number.NEGATIVE_INFINITY;
        if (bo !== ao) return bo - ao;
        // stable-ish fallback: url string so sort is deterministic
        const au = a.src || a.url || "";
        const bu = b.src || b.url || "";
        return bu < au ? -1 : bu > au ? 1 : 0;
    });
}

/** How many entries startup prefetch should aim for: 1/3 of max capacity. */
function prefetchTargetCount(maxEntries: number): number {
    const max = Math.max(1, Math.floor(maxEntries));
    return Math.max(1, Math.floor(max / 3));
}

function cacheKeyForUrl(url: string) {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (
            u.hostname.includes("tenor.com")
            || u.hostname.includes("giphy.com")
            || u.hostname.includes("discordapp")
            || u.hostname.includes("discord.com")
        ) {
            return `${u.origin}${u.pathname}`;
        }
        return u.href;
    } catch {
        return url;
    }
}

function keysForFavorite(ref: FavoriteGifRef) {
    const keys = new Set<string>();
    if (ref.url) {
        keys.add(cacheKeyForUrl(ref.url));
        keys.add(ref.url);
    }
    if (ref.src) {
        keys.add(cacheKeyForUrl(ref.src));
        keys.add(ref.src);
    }
    return [...keys];
}

function isLikelyGifMediaUrl(url: string) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    try {
        const u = new URL(url);
        const host = u.hostname;
        if (
            host.includes("tenor.com")
            || host.includes("giphy.com")
            || host.includes("media.discordapp")
            || host.includes("cdn.discordapp")
            || host.includes("discordapp.net")
        ) {
            return true;
        }
        return /\.(gif|mp4|webm|webp|png|jpe?g)(\?|$)/i.test(u.pathname);
    } catch {
        return false;
    }
}

/**
 * URL looks like an explicit video file.
 * Small Tenor mp4 "gifs" may still be cached if under the per-file size cap in media.ts.
 */
function isHeavyVideoUrl(url: string) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    try {
        const path = new URL(url).pathname.toLowerCase();
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(path);
    } catch {
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
    }
}

function isHeavyVideoMime(mime: string | null | undefined) {
    if (!mime) return false;
    const m = mime.toLowerCase().split(";")[0]!.trim();
    return m.startsWith("video/") || m === "application/mp4";
}

/** URL is a candidate for the favorite cache (size limits applied at download time). */
function isCacheableFavoriteUrl(url: string) {
    return isLikelyGifMediaUrl(url);
}

const STORE_KEY = "FavoriteGifCache.autoCacheDenylist";

let denied = new Set<string>();
let loaded = false;

function keysFor(url: string) {
    const k = cacheKeyForUrl(url);
    return k === url ? [url] : [k, url];
}

async function loadDenylist() {
    try {
        const arr = (await DataStore.get(STORE_KEY)) as string[] | undefined;
        denied = new Set(Array.isArray(arr) ? arr : []);
    } catch {
        denied = new Set();
    }
    loaded = true;
}

async function persist() {
    await DataStore.set(STORE_KEY, [...denied]);
}

function isAutoCacheDenied(url: string) {
    if (!url) return false;
    for (const k of keysFor(url)) {
        if (denied.has(k)) return true;
    }
    return false;
}

/** Block auto/prefetch/scroll caching until user manually caches again. */
async function denyAutoCache(url: string) {
    for (const k of keysFor(url)) denied.add(k);
    await persist();
}

/** Allow auto-cache again (and used when user clicks Cache GIF). */
async function allowAutoCache(url: string) {
    for (const k of keysFor(url)) denied.delete(k);
    await persist();
}

function denylistSize() {
    return denied.size;
}

function isDenylistLoaded() {
    return loaded;
}

type Native = PluginNative<typeof import("./native")>;

/** Plugin helpers are keyed by definePlugin name and sometimes folder name. */
function getPluginNative(): Native | null {
    try {
        const helpers =
            (typeof VencordNative !== "undefined" && (VencordNative as any)?.pluginHelpers)
            || (globalThis as any).VencordNative?.pluginHelpers
            || (globalThis as any).EquicordNative?.pluginHelpers
            || null;

        if (!helpers || typeof helpers !== "object") return null;

        // Keyed by definePlugin({ name }) — see other plugins (OpenInApp, FileUpload, …)
        const n =
            helpers.FavoriteGifCache
            ?? helpers.favoriteGifCache
            ?? null;

        if (n && typeof n.pickCacheDirectory === "function") return n as Native;
        return null;
    } catch {
        return null;
    }
}

function hasFileNative() {
    return getPluginNative() != null;
}

const inflight = new Map<string, Promise<{ data: Uint8Array; mime: string; } | null>>();

/** Skip single files bigger than this (huge "gif" mp4s). */
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

function guessMime(url: string, contentType: string | null) {
    if (contentType && !contentType.includes("octet-stream")) {
        return contentType.split(";")[0]!.trim();
    }
    const path = url.split("?")[0]!.toLowerCase();
    if (path.endsWith(".mp4")) return "video/mp4";
    if (path.endsWith(".webm")) return "video/webm";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    return "image/gif";
}

/**
 * Pull bytes for a favorite media URL.
 * Prefers native (main process) so Discord renderer CORS cannot block Tenor/CDN.
 */
async function downloadFavoriteMedia(
    url: string,
    fetchImpl: typeof fetch = fetch,
    maxBytes = MAX_ENTRY_BYTES,
): Promise<{ data: Uint8Array; mime: string; } | null> {
    const native = getPluginNative();
    if (native && typeof (native as any).fetchMedia === "function") {
        try {
            const res = await (native as any).fetchMedia(url, maxBytes);
            if (res?.data) {
                const data = res.data instanceof ArrayBuffer
                    ? new Uint8Array(res.data)
                    : new Uint8Array(res.data);
                if (data.byteLength && data.byteLength <= maxBytes) {
                    return {
                        data,
                        mime: guessMime(url, res.type || null),
                    };
                }
            }
        } catch {
            // fall through to renderer fetch
        }
    }

    try {
        const res = await fetchImpl(url, {
            // omit cors mode — let Electron use default; strict cors often fails here
            credentials: "include",
            cache: "force-cache",
        } as RequestInit);
        if (!res.ok) return null;
        const mime = guessMime(url, res.headers.get("content-type"));
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength || buf.byteLength > maxBytes) return null;
        return { data: buf, mime };
    } catch {
        return null;
    }
}

async function getCachedBytes(cache: FavoriteGifCache, url: string) {
    await cache.init();
    const key = cacheKeyForUrl(url);

    // peek first so miss path does not thrash metadata writes
    let entry = cache.peekSync(key);
    if (!entry && key !== url) entry = cache.peekSync(url);

    if (entry) {
        cache.touchSync(entry.key);
        return { data: entry.data.slice(), mimeType: entry.mimeType, key: entry.key };
    }

    return null;
}

type EnsureCachedOptions = {
    fetchImpl?: typeof fetch;
    allowEvict?: boolean;
    maxBytes?: number;
    /** Ignore denylist (manual "Cache GIF" action). */
    force?: boolean;
    /** Called to check auto-cache denylist. */
    isDenied?: (url: string) => boolean;
};

/**
 * Hit → local bytes.
 * Miss → download once (native preferred), store if under size/cap rules.
 */
async function ensureCached(
    cache: FavoriteGifCache,
    url: string,
    fetchImplOrOpts: typeof fetch | EnsureCachedOptions = fetch,
) {
    if (!url || !isLikelyGifMediaUrl(url)) return null;

    const opts: EnsureCachedOptions = typeof fetchImplOrOpts === "function"
        ? { fetchImpl: fetchImplOrOpts }
        : fetchImplOrOpts;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const allowEvict = opts.allowEvict === true;
    const maxBytes = opts.maxBytes ?? MAX_ENTRY_BYTES;
    const force = opts.force === true;

    if (!force && opts.isDenied?.(url)) return null;

    const key = cacheKeyForUrl(url);
    const hit = await getCachedBytes(cache, url);
    if (hit) {
        return { ...hit, fromCache: true as const, stored: true as const };
    }

    let pending = inflight.get(key);
    if (!pending) {
        pending = (async () => {
            try {
                return await downloadFavoriteMedia(url, fetchImpl, maxBytes);
            } catch {
                return null;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, pending);
    }

    const downloaded = await pending;
    if (!downloaded) return null;

    // Skip only truly huge videos; normal Tenor "gif" mp4s under the cap are OK
    if (downloaded.data.byteLength > maxBytes) {
        return null;
    }

    await cache.put(key, downloaded.data, downloaded.mime, { allowEvict });

    let entry = cache.peekSync(key);
    if (!entry && allowEvict) {
        await cache.put(key, downloaded.data, downloaded.mime, { allowEvict: true });
        entry = cache.peekSync(key);
    }

    return {
        data: downloaded.data,
        mimeType: entry?.mimeType || downloaded.mime,
        key,
        fromCache: false as const,
        stored: !!entry,
    };
}

async function cacheOnUserAction(
    cache: FavoriteGifCache,
    url: string,
    fetchImpl: typeof fetch = fetch,
    opts: {
        force?: boolean;
        isDenied?: (url: string) => boolean;
        maxBytes?: number;
    } = {},
) {
    return ensureCached(cache, url, {
        fetchImpl,
        allowEvict: true,
        force: opts.force === true,
        isDenied: opts.isDenied,
        maxBytes: opts.maxBytes,
    });
}

async function resolveDisplayUrl(
    cache: FavoriteGifCache,
    originalUrl: string,
    opts: { awaitMiss?: boolean; fetchImpl?: typeof fetch; allowEvict?: boolean } = {},
) {
    if (!originalUrl || originalUrl.startsWith("blob:") || originalUrl.startsWith("data:")) {
        return originalUrl;
    }

    const hot = cache.getCachedBlobUrl(cacheKeyForUrl(originalUrl))
        ?? cache.getCachedBlobUrl(originalUrl);
    if (hot) {
        cache.touchSync(cacheKeyForUrl(originalUrl));
        return hot;
    }

    const blob = await cache.getBlobUrl(cacheKeyForUrl(originalUrl));
    if (blob) return blob;
    if (originalUrl !== cacheKeyForUrl(originalUrl)) {
        const blob2 = await cache.getBlobUrl(originalUrl);
        if (blob2) return blob2;
    }

    const run = async () => {
        const ensured = await ensureCached(cache, originalUrl, {
            fetchImpl: opts.fetchImpl ?? fetch,
            allowEvict: opts.allowEvict,
        });
        if (!ensured) return originalUrl;
        if (ensured.stored) {
            const b = await cache.getBlobUrl(ensured.key);
            return b || originalUrl;
        }
        if (typeof Blob !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL) {
            try {
                return URL.createObjectURL(new Blob([ensured.data], { type: ensured.mimeType }));
            } catch {
                return originalUrl;
            }
        }
        return originalUrl;
    };

    if (opts.awaitMiss) return run();
    void run();
    return originalUrl;
}

function installFetchInterceptor(
    cache: FavoriteGifCache,
    isFavoriteUrl: (url: string) => boolean,
) {
    if (typeof globalThis.fetch !== "function") return () => {};

    const original = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
            const url = typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.href
                    : (input as Request).url;

            if (url && isFavoriteUrl(url)) {
                const hit = await getCachedBytes(cache, url);
                if (hit) {
                    return new Response(hit.data, {
                        status: 200,
                        statusText: "OK",
                        headers: {
                            "Content-Type": hit.mimeType,
                            "X-FavoriteGifCache": "HIT",
                        },
                    });
                }
            }
        } catch {
            // fall through
        }
        return original(input as any, init);
    };

    return () => {
        globalThis.fetch = original;
    };
}

/** Live cache handle for settings UI + plugin code. */
let active: FavoriteGifCache | null = null;
let rebuild: (() => Promise<FavoriteGifCache>) | null = null;

function setActiveCache(cache: FavoriteGifCache | null) {
    active = cache;
}

function getActiveCache() {
    return active;
}

function setRebuildCache(fn: (() => Promise<FavoriteGifCache>) | null) {
    rebuild = fn;
}

async function rebuildActiveCache() {
    if (!rebuild) throw new Error("Cache rebuild is not ready");
    return rebuild();
}

// component plugged in from index to avoid circular imports
let usageComponent: (() => any) | null = null;

function setUsageBarComponent(fn: () => any) {
    usageComponent = fn;
}

/** Wired from index.tsx after cache helpers exist. */
const settingsHooks = {
    onLimitsChange: () => {},
    onSmartEvictionChange: () => {},
    onCacheDirectoryChange: () => {},
};

const settings = definePluginSettings({
    cacheUsage: {
        type: OptionType.COMPONENT,
        description: "Cache usage and actions",
        component: () => (usageComponent ? usageComponent() : null),
    },
    maxEntries: {
        type: OptionType.NUMBER,
        description: "How many favorite GIFs to keep on disk (default 500)",
        default: DEFAULT_MAX_ENTRIES,
        onChange: () => settingsHooks.onLimitsChange(),
    },
    maxMegabytes: {
        type: OptionType.NUMBER,
        description: "Max total cache size in MB (default 500)",
        default: 500,
        onChange: () => settingsHooks.onLimitsChange(),
    },
    skipLargeFiles: {
        type: OptionType.BOOLEAN,
        description: "Skip files over 12 MB",
        default: true,
    },
    // Path is only set via Choose folder button — keep store, hide text field
    cacheDirectory: {
        type: OptionType.STRING,
        description: "Cache folder path",
        default: "",
        hidden: true,
        onChange: () => settingsHooks.onCacheDirectoryChange(),
    },
    smartEviction: {
        type: OptionType.BOOLEAN,
        description: "When full, replace least-used GIFs for new favorites / sends. Off = never delete for new downloads",
        default: true,
        onChange: () => settingsHooks.onSmartEvictionChange(),
    },
    prefetchOnStart: {
        type: OptionType.BOOLEAN,
        description: "On start, download newest favorites first until cache reaches 1/3 of max capacity",
        default: true,
    },
    rewriteFavoriteSrc: {
        type: OptionType.BOOLEAN,
        description: "Point favorite thumbnails at local blob URLs when we have them cached",
        default: true,
    },
});

function formatMB(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) return "0.0";
    return (bytes / (1024 * 1024)).toFixed(1);
}

function barColor(pct: number) {
    if (pct >= 90) return "var(--status-danger, #f23f43)";
    if (pct >= 70) return "var(--status-warning, #f0b232)";
    return "var(--brand-500, #5865f2)";
}

function toast(message: string, type: any) {
    try {
        Toasts.show({
            message,
            type,
            id: Toasts.genId(),
        });
    } catch {
        // ignore
    }
}

function UsageBar(props: {
    label: string;
    valueText: string;
    percent: number;
}) {
    const pct = Math.max(0, Math.min(100, props.percent));
    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
                gap: 8,
            }}>
                <span style={{
                    color: "var(--header-secondary)",
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.02em",
                }}>
                    {props.label}
                </span>
                <span style={{
                    color: "var(--text-default)",
                    fontSize: 12,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                }}>
                    {props.valueText}
                </span>
            </div>
            <div style={{
                height: 8,
                borderRadius: 4,
                background: "var(--background-modifier-accent, #3f4147)",
                overflow: "hidden",
            }}>
                <div style={{
                    width: `${pct}%`,
                    height: "100%",
                    borderRadius: 4,
                    background: barColor(pct),
                    transition: "width 0.35s ease, background 0.35s ease",
                }} />
            </div>
        </div>
    );
}

function CacheUsageBar() {
    const [count, setCount] = useState(0);
    const [bytes, setBytes] = useState(0);
    const [maxEntries, setMaxEntries] = useState(DEFAULT_MAX_ENTRIES);
    const [maxBytes, setMaxBytes] = useState(DEFAULT_MAX_BYTES);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pathLabel, setPathLabel] = useState("");
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let alive = true;

        (async () => {
            try {
                const cache = getActiveCache() ?? await rebuildActiveCache().catch(() => null);
                if (!cache) {
                    if (alive) {
                        setReady(false);
                        setCount(0);
                        setBytes(0);
                    }
                    return;
                }
                await cache.init();
                if (!alive) return;
                setCount(cache.size());
                setBytes(cache.bytes());
                setMaxEntries(cache.getMaxEntries());
                const mb = cache.getMaxBytes();
                setMaxBytes(Number.isFinite(mb) ? mb : DEFAULT_MAX_BYTES);
                const dir = (settings.store.cacheDirectory || "").trim();
                setPathLabel(dir || "IndexedDB (default)");
                setReady(true);
            } catch {
                if (alive) setReady(false);
            }
        })();

        return () => {
            alive = false;
        };
    }, [tick]);

    const entryPct = maxEntries > 0 ? (count / maxEntries) * 100 : 0;
    const bytePct = maxBytes > 0 ? (bytes / maxBytes) * 100 : 0;
    const usedMB = formatMB(bytes);
    const maxMB = formatMB(maxBytes);
    const leftMB = formatMB(Math.max(0, maxBytes - bytes));
    const hasCustomPath = !!(settings.store.cacheDirectory || "").trim();

    const onClear = async () => {
        setBusy(true);
        try {
            const cache = getActiveCache() ?? await rebuildActiveCache();
            await cache.clear();
            toast("Favorite GIF cache cleared", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch {
            toast("Failed to clear cache", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const onBrowse = async () => {
        const native = getPluginNative();
        if (!native?.pickCacheDirectory) {
            toast("Folder picker unavailable — restart Discord after updating", Toasts.Type.FAILURE);
            return;
        }
        setBusy(true);
        try {
            let startPath = (settings.store.cacheDirectory || "").trim();
            if (!startPath && typeof native.getDefaultCacheDir === "function") {
                startPath = await native.getDefaultCacheDir();
            }
            const picked = await native.pickCacheDirectory(startPath || undefined);
            if (!picked) {
                setBusy(false);
                return;
            }
            if (typeof native.ensureCacheDir === "function") {
                await native.ensureCacheDir(picked);
            }
            settings.store.cacheDirectory = picked;
            await rebuildActiveCache();
            toast("Cache folder updated", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch (e) {
            toast(e instanceof Error ? e.message : "Could not set folder", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const onUseDefault = async () => {
        setBusy(true);
        try {
            settings.store.cacheDirectory = "";
            await rebuildActiveCache();
            toast("Using default storage", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch {
            toast("Failed to reset storage", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{
            marginTop: 4,
            marginBottom: 8,
            padding: 12,
            borderRadius: 8,
            background: "var(--background-secondary-alt, #2b2d31)",
            border: "1px solid var(--background-modifier-accent, #3f4147)",
        }}>
            <div style={{
                color: "var(--header-primary)",
                fontSize: 14,
                fontWeight: 600,
                marginBottom: 4,
            }}>
                Cache usage
            </div>
            <div style={{
                marginBottom: 12,
                color: "var(--text-muted)",
                fontSize: 13,
                lineHeight: "18px",
            }}>
                {ready
                    ? `${leftMB} MB free · snapshot when you open this page`
                    : "Enable the plugin (or wait a moment) to load stats."}
            </div>

            <UsageBar
                label="GIFs"
                valueText={`${count} / ${maxEntries}`}
                percent={entryPct}
            />
            <UsageBar
                label="Size"
                valueText={`${usedMB} MB / ${maxMB} MB`}
                percent={bytePct}
            />

            <div style={{
                marginBottom: 10,
                color: "var(--text-muted)",
                fontSize: 12,
                wordBreak: "break-all",
            }}>
                <span style={{ fontWeight: 600, color: "var(--header-secondary)" }}>Location: </span>
                {pathLabel || "—"}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Button
                    size="small"
                    variant="dangerPrimary"
                    disabled={busy || !ready}
                    onClick={() => void onClear()}
                >
                    Clear cache
                </Button>
                <Button
                    size="small"
                    variant="primary"
                    disabled={busy}
                    onClick={() => void onBrowse()}
                >
                    Choose folder
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    disabled={busy || !hasCustomPath}
                    onClick={() => void onUseDefault()}
                >
                    Use default
                </Button>
            </div>
        </div>
    );
}

setUsageBarComponent(() => <CacheUsageBar />);

let cache: FavoriteGifCache | null = null;
let uninstallFetch: (() => void) | null = null;
let favoriteUrlSet = new Set<string>();
/** After first seed, keys that appear here are "just favorited". */
let favoritesSeeded = false;
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
let lastPickerInstance: { forceUpdate?: () => void; dead?: boolean } | null = null;

function maxBytesFromSettings() {
    const mb = Number(settings.store.maxMegabytes);
    if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_MAX_BYTES;
    return Math.floor(mb * 1024 * 1024);
}

/** Per-file download cap; Infinity when skipLargeFiles is off. */
function perFileMaxBytes() {
    return settings.store.skipLargeFiles === false ? Number.MAX_SAFE_INTEGER : MAX_ENTRY_BYTES;
}

function createBackend() {
    const dir = (settings.store.cacheDirectory || "").trim();
    const native = getPluginNative();
    return createBackendForPath(dir, native);
}

function getCache() {
    if (!cache) {
        cache = createFavoriteGifCache({
            maxEntries: settings.store.maxEntries || DEFAULT_MAX_ENTRIES,
            maxBytes: maxBytesFromSettings(),
            backend: createBackend(),
            smartEviction: settings.store.smartEviction !== false,
        });
        setActiveCache(cache);
    }
    return cache;
}

async function rebuildCache() {
    cache = null;
    setActiveCache(null);
    const c = getCache();
    await c.init();
    c.setSmartEviction(settings.store.smartEviction !== false);
    await applyLimitsFromSettings();
    return c;
}

setRebuildCache(rebuildCache);

async function applyLimitsFromSettings() {
    try {
        const c = getCache();
        await c.init();
        const max = Math.max(1, Number(settings.store.maxEntries) || DEFAULT_MAX_ENTRIES);
        await c.setMaxEntries(max);
        await c.setMaxBytes(maxBytesFromSettings());
        c.setSmartEviction(settings.store.smartEviction !== false);
        c.warmAllBlobUrls();
    } catch {
        // settings UI should still work
    }
}

settingsHooks.onLimitsChange = () => { void applyLimitsFromSettings(); };
settingsHooks.onSmartEvictionChange = () => {
    try {
        getCache().setSmartEviction(settings.store.smartEviction !== false);
    } catch {
        // ignore
    }
};
settingsHooks.onCacheDirectoryChange = () => { void rebuildCache(); };

/**
 * Update the known favorite URL set.
 * Returns primary media URLs that are newly favorited (not present last time).
 * First call only seeds state so startup/open does not look like mass "new" favorites.
 */
function refreshFavoriteSet(refs?: FavoriteGifRef[]): string[] {
    const list = refs ?? getFavoriteGifRefsFromFrecency();
    const next = new Set<string>();
    const primaryByKey = new Map<string, string>();

    for (const ref of list) {
        const primary = ref.src || ref.url;
        if (!primary) continue;
        for (const k of keysForFavorite(ref)) {
            next.add(k);
            if (!primaryByKey.has(k)) primaryByKey.set(k, primary);
        }
    }

    const newlyAddedUrls: string[] = [];
    if (favoritesSeeded) {
        const seenPrimary = new Set<string>();
        for (const key of next) {
            if (favoriteUrlSet.has(key)) continue;
            const primary = primaryByKey.get(key);
            if (!primary || seenPrimary.has(primary)) continue;
            seenPrimary.add(primary);
            newlyAddedUrls.push(primary);
        }
    }

    favoriteUrlSet = next;
    favoritesSeeded = true;
    getCache().setProtectedKeys(next);
    return newlyAddedUrls;
}

function isTrackedFavorite(url: string) {
    if (!url || !isLikelyGifMediaUrl(url)) return false;
    if (favoriteUrlSet.size === 0) return isLikelyGifMediaUrl(url);
    return favoriteUrlSet.has(url) || favoriteUrlSet.has(cacheKeyForUrl(url));
}

function shouldCacheFavoriteUrl(url: string, _format?: number) {
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return false;
    // Size filter happens at download time — don't block Tenor mp4 "gifs" by format alone
    return isCacheableFavoriteUrl(url) || isLikelyGifMediaUrl(url);
}

/** Prefer image-like urls when both src and url exist; otherwise first media url. */
function pickCacheableUrl(ref: { src?: string; url?: string; format?: number; }): string | null {
    const candidates = [ref.src, ref.url].filter((u): u is string => !!u && typeof u === "string");
    const nonVideo = candidates.filter(u => shouldCacheFavoriteUrl(u) && !isHeavyVideoUrl(u));
    if (nonVideo.length) return nonVideo[0]!;
    for (const u of candidates) {
        if (shouldCacheFavoriteUrl(u)) return u;
    }
    return null;
}

function originalSrc(gif: any) {
    return gif?.__fgcOriginalSrc || gif?.src || gif?.url || "";
}

function applySyncBlobSrc(favorites: any[], c: FavoriteGifCache) {
    if (!settings.store.rewriteFavoriteSrc) return 0;
    let changed = 0;
    for (const gif of favorites) {
        if (!gif || typeof gif !== "object") continue;
        const original = originalSrc(gif);
        if (!original || typeof original !== "string") continue;
        if (original.startsWith("blob:") || original.startsWith("data:")) continue;

        const local = c.resolveDisplayUrlSync(original);
        if (local && local.startsWith("blob:") && gif.src !== local) {
            if (!gif.__fgcOriginalSrc) gif.__fgcOriginalSrc = gif.src || original;
            if (!gif.__fgcOriginalUrl && gif.url) gif.__fgcOriginalUrl = gif.url;
            gif.src = local;
            changed += 1;
        }
    }
    return changed;
}

function safeForceUpdate(instance: any) {
    try {
        if (instance && !instance.dead && typeof instance.forceUpdate === "function") {
            instance.forceUpdate();
        }
    } catch {
        // picker stays usable even if forceUpdate flakes
    }
}

async function applyMaxFromSettings() {
    await applyLimitsFromSettings();
}

function toast(message: string, type: any) {
    try {
        Toasts.show({ message, type, id: Toasts.genId() });
    } catch {
        // ignore
    }
}

function resolveItemUrl(item: any): string | null {
    if (!item) return null;
    return pickCacheableUrl({
        src: item.__fgcOriginalSrc || item.src,
        url: item.__fgcOriginalUrl || item.url,
        format: item.format,
    }) || (typeof item.src === "string" && !item.src.startsWith("blob:") ? item.src : null)
        || (typeof item.url === "string" && !item.url.startsWith("blob:") ? item.url : null);
}

function isLocallyCached(url: string) {
    try {
        const c = getCache();
        const key = cacheKeyForUrl(url);
        return c.has(key) || c.has(url);
    } catch {
        return false;
    }
}

const autoCacheOpts = () => ({
    isDenied: isAutoCacheDenied,
    maxBytes: perFileMaxBytes(),
});

async function manualCacheGif(url: string) {
    await allowAutoCache(url);
    const c = getCache();
    await c.init();
    const res = await cacheOnUserAction(c, url, fetch, {
        force: true,
        maxBytes: perFileMaxBytes(),
    });
    if (res?.stored || c.has(cacheKeyForUrl(url))) {
        c.ensureBlobUrlSync(cacheKeyForUrl(url), { bumpUsage: true });
        toast("GIF cached", Toasts.Type.SUCCESS);
        safeForceUpdate(lastPickerInstance);
    } else {
        toast("Could not cache GIF", Toasts.Type.FAILURE);
    }
}

async function manualRemoveFromCache(url: string) {
    const c = getCache();
    await c.init();
    const key = cacheKeyForUrl(url);
    await c.delete(key);
    if (key !== url) await c.delete(url);
    await denyAutoCache(url);
    toast("Removed from cache — won't auto-cache again", Toasts.Type.SUCCESS);
    safeForceUpdate(lastPickerInstance);
}

/**
 * Startup auto-download:
 * newest favorite first, walk older, stop once cache size hits 1/3 of max capacity.
 * Never evicts during prefetch.
 */
async function prefetchFavorites() {
    try {
        const c = getCache();
        await c.init();
        refreshFavoriteSet();
        let refs = getFavoriteGifRefsFromFrecency();
        // Frecency can be empty early in boot — retry once
        if (!refs.length) {
            await new Promise(r => setTimeout(r, 2000));
            refs = getFavoriteGifRefsFromFrecency();
        }

        const target = prefetchTargetCount(c.getMaxEntries());
        // already at / over 1/3 capacity — only warm blobs for newest slice
        const newest = sortFavoritesNewestFirst(refs);
        const queue: string[] = [];
        const seen = new Set<string>();
        for (const ref of newest) {
            const u = pickCacheableUrl(ref);
            if (!u) continue;
            const key = cacheKeyForUrl(u);
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push(u);
        }
        if (!queue.length) return;

        if (c.size() >= target) {
            for (const url of queue.slice(0, target)) {
                c.ensureBlobUrlSync(cacheKeyForUrl(url), { bumpUsage: false });
            }
            return;
        }

        // Sequential newest→older so we fill 1/3 with the latest gifs, not random workers
        for (const url of queue) {
            if (c.size() >= target) break;
            try {
                const key = cacheKeyForUrl(url);
                if (c.has(key) || c.has(url)) {
                    c.ensureBlobUrlSync(key, { bumpUsage: false });
                    continue;
                }
                await ensureCached(c, url, { allowEvict: false, ...autoCacheOpts() });
                c.ensureBlobUrlSync(key, { bumpUsage: false });
                if (key !== url) c.ensureBlobUrlSync(url, { bumpUsage: false });
            } catch {
                // skip bad urls
            }
        }
        c.warmAllBlobUrls();
    } catch {
        // never take discord down
    }
}

export default definePlugin({
    name: "FavoriteGifCache",
    description: "Cache GIF picker favorites on disk so they load faster",
    authors: [{ name: "Arad", id: 825757055981846560n }],
    tags: ["GIF", "Media", "Performance"],

    settings,

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: [
                {
                    // plain favorites: ...
                    match: /(,suggestions:\i,favorites:)(\i),/,
                    replace: "$1$self.wrapFavorites(this,$2),",
                },
                {
                    // after FavoriteGifSearch: favorites:$self.getFav(x),
                    match: /(,suggestions:\i,favorites:)(\i\.getFav\(\i\)),/,
                    replace: "$1$self.wrapFavorites(this,$2),",
                },
            ],
        },
        {
            find: "handleSelectGIF=",
            replacement: {
                match: /handleSelectGIF=(\i)=>\{/,
                replace: "$&$self.onSelectGif($1);",
            },
        },
    ],

    /**
     * Right-click on GIF in picker (needs ExtraContextMenusAPI).
     */
    gifPickerContextMenu(instance: any) {
        try {
            const item = instance?.props?.item;
            const url = resolveItemUrl(item);
            if (!url || !isLikelyGifMediaUrl(url)) return null;

            const cached = isLocallyCached(url);

            return (
                <Menu.MenuGroup>
                    <Menu.MenuItem
                        id="fgc-cache-gif"
                        label="Cache GIF"
                        disabled={cached}
                        action={() => { void manualCacheGif(url); }}
                    />
                    <Menu.MenuItem
                        id="fgc-remove-cache"
                        label="Remove from cache"
                        color="danger"
                        disabled={!cached}
                        action={() => { void manualRemoveFromCache(url); }}
                    />
                </Menu.MenuGroup>
            );
        } catch {
            return null;
        }
    },

    /**
     * User clicked a GIF to send. If it is a favorite and not cached yet,
     * store it (may evict least-used when full).
     */
    onSelectGif(gif?: { url?: string; src?: string; format?: number; __fgcOriginalSrc?: string; __fgcOriginalUrl?: string; }) {
        try {
            if (!gif) return;
            const remote = pickCacheableUrl({
                src: gif.__fgcOriginalSrc
                    || (typeof gif.src === "string" && !gif.src.startsWith("blob:") ? gif.src : "")
                    || undefined,
                url: gif.__fgcOriginalUrl
                    || (typeof gif.url === "string" && !gif.url.startsWith("blob:") ? gif.url : "")
                    || undefined,
                format: gif.format,
            });
            if (!remote) return;
            if (!isTrackedFavorite(remote) && !isTrackedFavorite(gif.url || "") && !isTrackedFavorite(gif.src || "")) {
                // still cache if it looks like a favorite media host from picker
                if (!isLikelyGifMediaUrl(remote)) return;
            }

            const c = getCache();
            const key = cacheKeyForUrl(remote);
            if (isAutoCacheDenied(remote)) return;

            if (c.has(key) || c.has(remote)) {
                c.touchSync(key) || c.touchSync(remote);
                return;
            }

            void (async () => {
                try {
                    await c.init();
                    await cacheOnUserAction(c, remote, fetch, autoCacheOpts());
                    c.ensureBlobUrlSync(cacheKeyForUrl(remote), { bumpUsage: true });
                } catch {
                    // send still works without cache
                }
            })();
        } catch {
            // ignore
        }
    },

    wrapFavorites(instance: any, favorites: any[]) {
        try {
            if (!Array.isArray(favorites)) return favorites;
            if (instance && typeof instance === "object") lastPickerInstance = instance;

            const refs: FavoriteGifRef[] = favorites
                .map((g: any) => ({
                    url: g?.url || g?.src || "",
                    src: g?.src || g?.url || "",
                    width: g?.width,
                    height: g?.height,
                    format: g?.format,
                    order: g?.order,
                }))
                .filter(r => r.url || r.src);

            const newlyFavorited = refreshFavoriteSet(refs);
            const c = getCache();
            applySyncBlobSrc(favorites, c);

            void (async () => {
                try {
                    await c.init();
                    c.warmAllBlobUrls();
                    let changed = applySyncBlobSrc(favorites, c) > 0;

                    // Brand-new favorites may steal a slot from least-used when full
                    // (still skip mp4/video — those stay on the network)
                    for (const u of newlyFavorited) {
                        const cacheUrl = pickCacheableUrl({ src: u, url: u });
                        if (!cacheUrl || isAutoCacheDenied(cacheUrl)) continue;
                        try {
                            await cacheOnUserAction(c, cacheUrl, fetch, autoCacheOpts());
                            const key = cacheKeyForUrl(cacheUrl);
                            c.ensureBlobUrlSync(key, { bumpUsage: false });
                        } catch {
                            // ignore single failures
                        }
                    }

                    for (const ref of refs) {
                        const u = pickCacheableUrl(ref);
                        if (!u || isAutoCacheDenied(u)) continue;
                        const key = cacheKeyForUrl(u);

                        // Scrolling: only fill free slots, never thrash-evict
                        if (!c.has(key) && !c.has(u)) {
                            if (c.size() < c.getMaxEntries()) {
                                await ensureCached(c, u, { allowEvict: false, ...autoCacheOpts() });
                            }
                        }

                        const blob = c.ensureBlobUrlSync(key, { bumpUsage: false })
                            || c.ensureBlobUrlSync(u, { bumpUsage: false });
                        if (!blob) continue;

                        for (const gif of favorites) {
                            const orig = originalSrc(gif);
                            if (!orig || orig.startsWith("blob:")) continue;
                            if (cacheKeyForUrl(orig) === key || orig === u || orig === key) {
                                if (gif.src !== blob) {
                                    if (!gif.__fgcOriginalSrc) gif.__fgcOriginalSrc = gif.src || orig;
                                    if (!gif.__fgcOriginalUrl && gif.url) gif.__fgcOriginalUrl = gif.url;
                                    gif.src = blob;
                                    // some builds read .url for the media element
                                    if (typeof gif.url === "string" && !gif.url.startsWith("blob:")) {
                                        gif.url = blob;
                                    }
                                    c.touchSync(key) || c.touchSync(u);
                                    changed = true;
                                }
                            }
                        }
                    }

                    if (changed) safeForceUpdate(instance ?? lastPickerInstance);
                } catch {
                    // ignore
                }
            })();
        } catch {
            // ignore
        }
        return favorites;
    },

    async start() {
        try {
            await loadDenylist();
            // loads IndexedDB from last session — does not wipe on restart
            await applyMaxFromSettings();
            refreshFavoriteSet();
            uninstallFetch = installFetchInterceptor(getCache(), isTrackedFavorite);

            if (settings.store.prefetchOnStart) {
                // sooner + one backup pass so boot races with Frecency still fill the cache
                prefetchTimer = setTimeout(() => {
                    void prefetchFavorites().then(() => {
                        setTimeout(() => void prefetchFavorites(), 8000);
                    });
                }, 1200);
            }
        } catch (e) {
            console.error("[FavoriteGifCache] failed to start", e);
        }
    },

    stop() {
        // only drop process state. IndexedDB on disk is left alone.
        if (prefetchTimer) {
            clearTimeout(prefetchTimer);
            prefetchTimer = null;
        }
        if (uninstallFetch) {
            uninstallFetch();
            uninstallFetch = null;
        }
        cache = null;
        setActiveCache(null);
        favoriteUrlSet = new Set();
        favoritesSeeded = false;
        lastPickerInstance = null;
    },
});

