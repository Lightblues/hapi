import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { basename, join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { getProjectPath } from "./path";
import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from "@/modules/common/session/BaseSessionScanner";

/**
 * Known internal Claude Code event types that should be silently skipped.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

/**
 * Session discovery mode:
 * - 'hook': Wait for session ID via SessionStart hook callback (claude supports --settings)
 * - 'directory-scan': Actively scan the project directory for new .jsonl files
 *   (claude-internal does not support --settings, so hooks are unavailable)
 */
export type SessionDiscoveryMode = 'hook' | 'directory-scan';

export async function createSessionScanner(opts: {
    sessionId: string | null;
    workingDirectory: string;
    onMessage: (message: RawJSONLines) => void;
    /** How to discover new session IDs. Default: 'hook' */
    discoveryMode?: SessionDiscoveryMode;
    /** Called when a session is discovered via directory scan (only used in 'directory-scan' mode) */
    onSessionDiscovered?: (sessionId: string) => void;
}) {
    const discoveryMode = opts.discoveryMode ?? 'hook';
    const scanner = new ClaudeSessionScanner({
        sessionId: opts.sessionId,
        workingDirectory: opts.workingDirectory,
        onMessage: opts.onMessage,
        discoveryMode,
        onSessionDiscovered: opts.onSessionDiscovered
    });

    await scanner.start();

    return {
        cleanup: async () => {
            await scanner.cleanup();
        },
        onNewSession: (sessionId: string) => {
            scanner.onNewSession(sessionId);
        }
    };
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


class ClaudeSessionScanner extends BaseSessionScanner<RawJSONLines> {
    private readonly projectDir: string;
    private readonly onMessage: (message: RawJSONLines) => void;
    private readonly onSessionDiscovered?: (sessionId: string) => void;
    private readonly discoveryMode: SessionDiscoveryMode;
    private readonly finishedSessions = new Set<string>();
    private readonly pendingSessions = new Set<string>();
    private currentSessionId: string | null;
    private readonly scannedSessions = new Set<string>();
    private reportedSessionId: string | null;
    private readonly fileMtimeCache = new Map<string, number>();
    private readonly scannerStartMs: number;

    constructor(opts: {
        sessionId: string | null;
        workingDirectory: string;
        onMessage: (message: RawJSONLines) => void;
        discoveryMode: SessionDiscoveryMode;
        onSessionDiscovered?: (sessionId: string) => void;
    }) {
        super({ intervalMs: 3000 });
        this.scannerStartMs = Date.now();
        this.projectDir = getProjectPath(opts.workingDirectory);
        this.onMessage = opts.onMessage;
        this.onSessionDiscovered = opts.onSessionDiscovered;
        this.discoveryMode = opts.discoveryMode;
        this.currentSessionId = opts.sessionId;
        this.reportedSessionId = opts.sessionId;
        logger.debug(`[SESSION_SCANNER] Project dir: ${this.projectDir}, discovery: ${this.discoveryMode}, sessionId: ${opts.sessionId ?? 'none'}`);
    }

    public onNewSession(sessionId: string): void {
        if (this.currentSessionId === sessionId) {
            return;
        }
        if (this.finishedSessions.has(sessionId)) {
            return;
        }
        if (this.pendingSessions.has(sessionId)) {
            return;
        }
        if (this.currentSessionId) {
            this.pendingSessions.add(this.currentSessionId);
        }
        logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`);
        this.currentSessionId = sessionId;
        this.reportSessionId(sessionId);
        this.invalidate();
    }

    protected async initialize(): Promise<void> {
        if (!this.currentSessionId) {
            return;
        }
        const sessionFile = this.sessionFilePath(this.currentSessionId);
        const { events, totalLines } = await readSessionLog(sessionFile, 0);
        logger.debug(`[SESSION_SCANNER] Seeded ${events.length} existing messages from ${this.currentSessionId}`);
        const keys = events.map((entry) => messageKey(entry.event));
        this.seedProcessedKeys(keys);
        this.setCursor(sessionFile, totalLines);
    }

    protected async beforeScan(): Promise<void> {
        this.scannedSessions.clear();
        this.fileMtimeCache.clear();
    }

    protected async findSessionFiles(): Promise<string[]> {
        if (this.discoveryMode === 'directory-scan') {
            const files = await this.listSessionFiles();
            if (files.length === 0) {
                return files;
            }

            if (!this.currentSessionId) {
                // No active session yet — discover the newest file modified AFTER scannerStartMs
                const candidate = files.find(f => (this.fileMtimeCache.get(f) ?? 0) >= this.scannerStartMs);
                const newestSessionId = candidate ? sessionIdFromPath(candidate) : null;
                if (newestSessionId) {
                    logger.debug(`[SESSION_SCANNER] Discovered session: ${newestSessionId}`);
                    this.currentSessionId = newestSessionId;
                    this.reportSessionId(newestSessionId);
                }
            } else {
                // Detect new session: if the newest file belongs to a different session, switch
                const newestFile = files[0];
                const newestSessionId = sessionIdFromPath(newestFile);
                if (newestSessionId && newestSessionId !== this.currentSessionId) {
                    const newestMtime = this.fileMtimeCache.get(newestFile) ?? 0;
                    const currentFile = this.sessionFilePath(this.currentSessionId);
                    const currentMtime = this.fileMtimeCache.get(currentFile) ?? 0;
                    if (newestMtime > currentMtime && newestMtime >= this.scannerStartMs) {
                        logger.debug(`[SESSION_SCANNER] Switching session: ${this.currentSessionId} -> ${newestSessionId}`);
                        this.currentSessionId = newestSessionId;
                        this.reportSessionId(newestSessionId);
                    }
                }
            }

            return files;
        }

        // In hook mode, only scan known session files
        const files = new Set<string>();
        for (const sessionId of this.pendingSessions) {
            files.add(this.sessionFilePath(sessionId));
        }
        if (this.currentSessionId && !this.pendingSessions.has(this.currentSessionId)) {
            files.add(this.sessionFilePath(this.currentSessionId));
        }
        for (const watched of this.getWatchedFiles()) {
            files.add(watched);
        }
        return [...files];
    }

    protected shouldWatchFile(filePath: string): boolean {
        if (this.discoveryMode !== 'directory-scan') {
            return true;
        }
        if (!this.currentSessionId) {
            return false;
        }
        const sessionId = sessionIdFromPath(filePath);
        return sessionId === this.currentSessionId;
    }

    private async listSessionFiles(): Promise<string[]> {
        try {
            const entries = await readdir(this.projectDir);
            const jsonlFiles: { path: string; mtimeMs: number }[] = [];

            for (const entry of entries) {
                if (!entry.endsWith('.jsonl')) {
                    continue;
                }
                const filePath = join(this.projectDir, entry);
                try {
                    const fileStat = await stat(filePath);
                    jsonlFiles.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
                    this.fileMtimeCache.set(filePath, fileStat.mtimeMs);
                } catch {
                    continue;
                }
            }

            jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
            return jsonlFiles.map(f => f.path);
        } catch (error) {
            // Directory may not exist yet
            return [];
        }
    }

    protected async parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<RawJSONLines>> {
        const sessionId = sessionIdFromPath(filePath);
        if (sessionId) {
            this.scannedSessions.add(sessionId);
        }

        // In directory-scan mode with an active session, skip parsing unrelated files
        if (this.discoveryMode === 'directory-scan' && this.currentSessionId && sessionId !== this.currentSessionId) {
            return { events: [], nextCursor: cursor };
        }

        const { events, totalLines } = await readSessionLog(filePath, cursor);
        return {
            events,
            nextCursor: totalLines
        };
    }

    protected generateEventKey(event: RawJSONLines): string {
        return messageKey(event);
    }

    protected async handleFileScan(stats: SessionFileScanStats<RawJSONLines>): Promise<void> {
        const sessionId = sessionIdFromPath(stats.filePath);

        // Only emit messages for the current session
        if (this.currentSessionId && sessionId !== this.currentSessionId) {
            return;
        }

        for (const message of stats.events) {
            const id = message.type === 'summary' ? message.leafUuid : message.uuid;
            logger.debug(`[SESSION_SCANNER] Sending new message: type=${message.type}, uuid=${id}`);
            this.onMessage(message);
        }
        if (stats.parsedCount > 0) {
            const sid = sessionIdFromPath(stats.filePath) ?? 'unknown';
            logger.debug(`[SESSION_SCANNER] Session ${sid}: found=${stats.parsedCount}, skipped=${stats.skippedCount}, sent=${stats.newCount}`);
        }
    }

    protected async afterScan(): Promise<void> {
        for (const sessionId of this.scannedSessions) {
            if (this.pendingSessions.has(sessionId)) {
                this.pendingSessions.delete(sessionId);
                this.finishedSessions.add(sessionId);
            }
        }

        // In directory-scan mode, prune watchers for non-current sessions
        if (this.discoveryMode === 'directory-scan' && this.currentSessionId) {
            const activeFile = this.sessionFilePath(this.currentSessionId);
            this.pruneWatchers([activeFile]);
        }
    }

    private reportSessionId(sessionId: string): void {
        if (this.reportedSessionId === sessionId) {
            return;
        }
        this.reportedSessionId = sessionId;
        this.onSessionDiscovered?.(sessionId);
    }

    private sessionFilePath(sessionId: string): string {
        return join(this.projectDir, `${sessionId}.jsonl`);
    }
}

//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

/**
 * Read and parse session log file.
 * Returns only valid conversation messages, silently skipping internal events.
 */
async function readSessionLog(filePath: string, startLine: number): Promise<{ events: SessionFileScanEntry<RawJSONLines>[]; totalLines: number }> {
    logger.debug(`[SESSION_SCANNER] Reading session file: ${filePath}`);
    let file: string;
    try {
        file = await readFile(filePath, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${filePath}`);
        return { events: [], totalLines: startLine };
    }
    const lines = file.split('\n');
    const hasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
    const totalLines = hasTrailingEmpty ? lines.length - 1 : lines.length;
    let effectiveStartLine = startLine;
    if (effectiveStartLine > totalLines) {
        effectiveStartLine = 0;
    }
    const messages: SessionFileScanEntry<RawJSONLines>[] = [];
    for (let index = effectiveStartLine; index < lines.length; index += 1) {
        const l = lines[index];
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);

            // Silently skip known internal Claude Code events
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }

            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped.
                continue;
            }
            messages.push({ event: parsed.data, lineIndex: index });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return { events: messages, totalLines };
}

function sessionIdFromPath(filePath: string): string | null {
    const base = basename(filePath);
    if (!base.endsWith('.jsonl')) {
        return null;
    }
    return base.slice(0, -'.jsonl'.length);
}
