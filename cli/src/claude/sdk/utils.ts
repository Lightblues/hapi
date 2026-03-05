/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { logger } from '@/ui/logger'

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
function findWindowsClaudePath(candidates: readonly string[]): string | null {
    const homeDir = homedir()
    const path = require('node:path')

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
            if (existsSync(candidate)) {
                logger.debug(`[Claude SDK] Found Windows ${cmd}.exe at: ${candidate}`)
                return candidate
            }
        }

        // Try 'where' to find in PATH
        try {
            const result = execSync(`where ${cmd}.exe`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: homeDir
            }).trim().split('\n')[0].trim()
            if (result && existsSync(result)) {
                logger.debug(`[Claude SDK] Found Windows ${cmd}.exe via where: ${result}`)
                return result
            }
        } catch {
            // where didn't find it
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
 */
export function getDefaultClaudeCodePath(flavor?: string): string {
    if (process.env.HAPI_CLAUDE_PATH) {
        logger.debug(`[Claude SDK] Using HAPI_CLAUDE_PATH: ${process.env.HAPI_CLAUDE_PATH}`)
        return process.env.HAPI_CLAUDE_PATH
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
