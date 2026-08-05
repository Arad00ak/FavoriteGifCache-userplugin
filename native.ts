/*
 * Desktop-only helpers (Node / Electron). Used when the user picks a folder
 * for the GIF cache instead of IndexedDB.
 */

import { app, dialog } from "electron";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "fs";
import { join } from "path";

export type NativeCacheRecord = {
    key: string;
    data: ArrayBuffer;
    mimeType: string;
    useCount: number;
    lastUsed: number;
    createdAt: number;
    size: number;
};

function blobsDir(dir: string) {
    return join(dir, "blobs");
}

function metaPath(dir: string) {
    return join(dir, "meta.json");
}

function fileNameForKey(key: string) {
    return Buffer.from(key, "utf8").toString("base64url");
}

function readMeta(dir: string): Record<string, Omit<NativeCacheRecord, "data" | "key"> & { file: string; }> {
    const p = metaPath(dir);
    if (!existsSync(p)) return {};
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return {};
    }
}

function writeMeta(dir: string, meta: Record<string, unknown>) {
    writeFileSync(metaPath(dir), JSON.stringify(meta), "utf8");
}

export function getDefaultCacheDir() {
    return join(app.getPath("userData"), "FavoriteGifCache");
}

/** Hosts we are willing to pull favorite media from (main process = no CORS). */
const ALLOWED_MEDIA_HOSTS = [
    // Tenor (legacy — may die; Klipy fallbacks tried in media.ts)
    "media.tenor.com",
    "tenor.com",
    "c.tenor.com",
    // Klipy (Tenor replacement Discord / partners are moving to)
    "media.klipy.com",
    "cdn.klipy.com",
    "static.klipy.com",
    "gifs.klipy.com",
    "i.klipy.com",
    "media1.klipy.com",
    "media2.klipy.com",
    "c.klipy.com",
    "klipy.com",
    // Giphy
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
    "i.giphy.com",
    // Discord CDN / proxy
    "media.discordapp.net",
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "discordapp.net",
    "discord.com",
];

const DEFAULT_MAX_DOWNLOAD = 12 * 1024 * 1024; // 12 MB

function hostAllowed(hostname: string) {
    const h = hostname.toLowerCase();
    if (h.includes("klipy.com") || h.includes("tenor.com") || h.includes("giphy.com")) {
        return true;
    }
    return ALLOWED_MEDIA_HOSTS.some(a => h === a || h.endsWith("." + a));
}

/**
 * Download favorite media in the Electron main process (bypasses renderer CORS).
 * Rejects oversized files so huge mp4s never enter the cache.
 */
export async function fetchMedia(
    _e: unknown,
    url: string,
    maxBytes: number = DEFAULT_MAX_DOWNLOAD,
): Promise<{ data: ArrayBuffer; type: string; } | null> {
    if (!url || typeof url !== "string") return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!hostAllowed(parsed.hostname)) return null;

    const res = await fetch(parsed.href, {
        headers: { Accept: "image/*,video/*,*/*;q=0.8" },
        redirect: "follow",
    });
    if (!res.ok) return null;

    const lenHeader = res.headers.get("content-length");
    if (lenHeader) {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len > maxBytes) return null;
    }

    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > maxBytes) return null;

    const type = (res.headers.get("content-type") || "application/octet-stream").split(";")[0]!.trim();
    return { data: buf, type };
}

export async function pickCacheDirectory(_e: unknown, defaultPath?: string) {
    const res = await dialog.showOpenDialog({
        title: "Choose FavoriteGifCache folder",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: defaultPath || getDefaultCacheDir(),
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
}

export async function ensureCacheDir(_e: unknown, dir: string) {
    if (!dir || typeof dir !== "string") throw new Error("Invalid cache directory");
    mkdirSync(dir, { recursive: true });
    mkdirSync(blobsDir(dir), { recursive: true });
    if (!existsSync(metaPath(dir))) writeMeta(dir, {});
    return true;
}

export async function loadAllEntries(_e: unknown, dir: string): Promise<NativeCacheRecord[]> {
    await ensureCacheDir(_e, dir);
    const meta = readMeta(dir);
    const out: NativeCacheRecord[] = [];

    for (const [key, info] of Object.entries(meta)) {
        try {
            const file = join(blobsDir(dir), info.file || fileNameForKey(key));
            if (!existsSync(file)) continue;
            const buf = readFileSync(file);
            const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            out.push({
                key,
                data,
                mimeType: info.mimeType || "application/octet-stream",
                useCount: Number(info.useCount) || 0,
                lastUsed: Number(info.lastUsed) || 0,
                createdAt: Number(info.createdAt) || 0,
                size: typeof info.size === "number" ? info.size : buf.byteLength,
            });
        } catch {
            // skip broken row
        }
    }
    return out;
}

export async function putEntry(_e: unknown, dir: string, entry: NativeCacheRecord) {
    await ensureCacheDir(_e, dir);
    const file = fileNameForKey(entry.key);
    const full = join(blobsDir(dir), file);
    const bytes = Buffer.from(entry.data);
    writeFileSync(full, bytes);

    const meta = readMeta(dir);
    meta[entry.key] = {
        file,
        mimeType: entry.mimeType || "application/octet-stream",
        useCount: entry.useCount || 0,
        lastUsed: entry.lastUsed || Date.now(),
        createdAt: entry.createdAt || Date.now(),
        size: entry.size || bytes.byteLength,
    };
    writeMeta(dir, meta);
}

export async function deleteEntry(_e: unknown, dir: string, key: string) {
    await ensureCacheDir(_e, dir);
    const meta = readMeta(dir);
    const info = meta[key];
    if (info?.file) {
        const full = join(blobsDir(dir), info.file);
        if (existsSync(full)) {
            try {
                unlinkSync(full);
            } catch {
                // ignore
            }
        }
    }
    delete meta[key];
    writeMeta(dir, meta);
}

export async function deleteEntries(_e: unknown, dir: string, keys: string[]) {
    for (const key of keys) {
        await deleteEntry(_e, dir, key);
    }
}

export async function clearCacheDir(_e: unknown, dir: string) {
    await ensureCacheDir(_e, dir);
    const bdir = blobsDir(dir);
    if (existsSync(bdir)) {
        for (const name of readdirSync(bdir)) {
            try {
                unlinkSync(join(bdir, name));
            } catch {
                // ignore
            }
        }
    }
    writeMeta(dir, {});
}

/** Wipe directory contents entirely (optional hard reset). */
export async function wipeCacheDir(_e: unknown, dir: string) {
    if (!dir || !existsSync(dir)) return;
    rmSync(dir, { recursive: true, force: true });
    await ensureCacheDir(_e, dir);
}
