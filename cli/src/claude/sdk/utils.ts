/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { logger } from '@/ui/logger'

const windowsPath = path.win32

/**
 * Candidate command names, ordered by priority.
 */
const DEFAULT_CLAUDE_COMMAND_CANDIDATES = ['claude-internal', 'claude'] as const

function getCandidatesForFlavor(flavor?: string): readonly string[] {
    if (flavor === 'claude') {
        return ['claude']
    }
    if (flavor === 'claude-internal') {
        return ['claude-internal']
    }
    return DEFAULT_CLAUDE_COMMAND_CANDIDATES
}

/**
 * Find Claude executable path on Windows.
 * Returns absolute path to claude.exe for use with shell: false
 */
function resolveWindowsNpmShimExecutable(shimPath: string): string | null {
    const shimDirectory = windowsPath.dirname(shimPath)
    const executableName = windowsPath.basename(shimPath, windowsPath.extname(shimPath))
    const packageExecutable = windowsPath.join(shimDirectory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', `${executableName}.exe`)

    if (existsSync(packageExecutable)) {
        logger.debug(`[Claude SDK] Resolved Windows npm shim ${shimPath} to ${packageExecutable}`)
        return packageExecutable
    }

    return null
}

function resolveWindowsClaudePathCandidate(candidate: string): string | null {
    if (!existsSync(candidate)) {
        return null
    }

    if (windowsPath.extname(candidate).toLowerCase() === '.exe') {
        return candidate
    }

    return resolveWindowsNpmShimExecutable(candidate)
}

function findWhereResults(command: string): string[] {
    try {
        const result = execFileSync('where.exe', [command], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir(),
            windowsHide: process.platform === 'win32'
        })

        return result
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
    } catch {
        return []
    }
}

function findWindowsClaudePath(candidates: readonly string[]): string | null {
    const homeDir = homedir()

    for (const cmd of candidates) {
        // Known installation paths
        const paths = [
            path.join(homeDir, '.local', 'bin', `${cmd}.exe`),
            path.join(homeDir, 'AppData', 'Local', 'Programs', cmd, `${cmd}.exe`),
        ]

        if (cmd === 'claude') {
            paths.push(path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages',
                'Anthropic.claude-code_Microsoft.Winget.Source_8wekyb3d8bbwe', `${cmd}.exe`))
        }

        for (const candidate of paths) {
            const resolved = resolveWindowsClaudePathCandidate(candidate)
            if (resolved) {
                logger.debug(`[Claude SDK] Found Windows ${cmd}.exe at: ${resolved}`)
                return resolved
            }
        }

        // Try PATH lookup. npm global installs usually expose claude.cmd/claude
        // shims, while HAPI spawns Claude with shell:false and needs the real exe.
        for (const variant of [`${cmd}.exe`, `${cmd}.cmd`, cmd]) {
            for (const result of findWhereResults(variant)) {
                const resolved = resolveWindowsClaudePathCandidate(result)
                if (resolved) {
                    logger.debug(`[Claude SDK] Found Windows ${cmd}.exe via where ${variant}: ${resolved}`)
                    return resolved
                }
            }
        }
    }

    return null
}

/**
 * Try to find globally installed Claude CLI.
 * On Windows: Returns absolute path to .exe (for shell: false)
 * On Unix: Returns command name if it works, or actual path via which
 */
function findGlobalClaudePath(candidates: readonly string[]): string | null {
    const homeDir = homedir()

    if (process.platform === 'win32') {
        return findWindowsClaudePath(candidates)
    }

    // Unix: try each candidate in priority order
    for (const cmd of candidates) {
        try {
            execSync(`${cmd} --version`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: homeDir
            })
            logger.debug(`[Claude SDK] Global ${cmd} command available`)
            return cmd
        } catch {
            // not available
        }

        try {
            const result = execSync(`which ${cmd}`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: homeDir
            }).trim()
            if (result && existsSync(result)) {
                logger.debug(`[Claude SDK] Found global ${cmd} path via which: ${result}`)
                return result
            }
        } catch {
            // which didn't find it
        }
    }

    return null
}

/**
 * Get default path to Claude Code executable.
 * Priority: HAPI_CLAUDE_PATH env > flavor-aware candidate detection
 *
 * On Windows we tolerate npm shim paths (`claude.cmd` / extensionless `claude`)
 * by resolving them to the real `claude.exe`, since Claude is spawned with shell:false.
 */
export function getDefaultClaudeCodePath(flavor?: string): string {
    if (process.env.HAPI_CLAUDE_PATH) {
        const configuredPath = process.env.HAPI_CLAUDE_PATH
        if (process.platform === 'win32') {
            const resolved = resolveWindowsClaudePathCandidate(configuredPath)
            if (resolved) {
                logger.debug(`[Claude SDK] Using resolved HAPI_CLAUDE_PATH: ${resolved}`)
                return resolved
            }
        }
        logger.debug(`[Claude SDK] Using HAPI_CLAUDE_PATH: ${configuredPath}`)
        return configuredPath
    }

    const candidates = getCandidatesForFlavor(flavor)
    logger.debug(`[Claude SDK] Searching for CLI with flavor=${flavor ?? 'unset'}, candidates=[${candidates.join(', ')}]`)

    const globalPath = findGlobalClaudePath(candidates)
    if (!globalPath) {
        const requiredCmd = flavor ?? 'claude or claude-internal'
        throw new Error(
            `Claude Code CLI not found on PATH (required: ${requiredCmd}).\n` +
            'Install the required CLI or set HAPI_CLAUDE_PATH.'
        )
    }
    return globalPath
}

/**
 * Log debug message
 */
export function logDebug(message: string): void {
    if (process.env.DEBUG) {
        logger.debug(message)
        console.log(message)
    }
}

/**
 * Stream async messages to stdin
 */
export async function streamToStdin(
    stream: AsyncIterable<unknown>,
    stdin: NodeJS.WritableStream,
    abort?: AbortSignal
): Promise<void> {
    for await (const message of stream) {
        if (abort?.aborted) break
        stdin.write(JSON.stringify(message) + '\n')
    }
    stdin.end()
}
