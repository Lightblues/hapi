import { homedir } from "node:os";
import { join, resolve } from "node:path";

let configDirOverride: string | null = null;

/**
 * Set the config directory based on the detected CLI type.
 * Should be called once at startup when the CLI executable is resolved.
 */
export function setCliConfigDir(cliPath: string): void {
    if (cliPath.includes('claude-internal')) {
        configDirOverride = join(homedir(), '.claude-internal');
    } else {
        configDirOverride = null;
    }
}

export function getClaudeConfigDir(): string {
    if (process.env.CLAUDE_CONFIG_DIR) {
        return process.env.CLAUDE_CONFIG_DIR;
    }
    if (configDirOverride) {
        return configDirOverride;
    }
    return join(homedir(), '.claude');
}

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9]/g, '-');
    const claudeConfigDir = getClaudeConfigDir();
    return join(claudeConfigDir, 'projects', projectId);
}
