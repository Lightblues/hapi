import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { createSessionScanner, type SessionDiscoveryMode } from "./utils/sessionScanner";
import { isClaudeChatVisibleMessage } from "./utils/chatVisibility";
import { BaseLocalLauncher } from "@/modules/common/launcher/BaseLocalLauncher";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import { setCliConfigDir } from "./utils/path";
import { logger } from "@/ui/logger";

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {

    // Configure config dir before creating scanner, so getProjectPath() uses the correct base dir
    const claudeCommand = getDefaultClaudeCodePath(session.flavor);
    setCliConfigDir(claudeCommand);

    // Determine session discovery mode based on flavor:
    // - claude: supports --settings, so SessionStart hook works → use 'hook' mode
    // - claude-internal: does NOT support --settings, hooks unavailable → use 'directory-scan' mode
    const discoveryMode: SessionDiscoveryMode = session.flavor === 'claude-internal'
        ? 'directory-scan'
        : 'hook';

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        discoveryMode,
        onMessage: (message) => {
            // Block SDK summary messages - we generate our own
            if (message.type === 'summary') {
                return
            }
            // Filter out internal meta messages (e.g. skill injections) and
            // compact summaries to avoid them appearing in the web UI
            if (message.isMeta || message.isCompactSummary) {
                return
            }
            // Filter out invisible system messages (e.g. init, stop_hook_summary)
            // to avoid them showing as raw JSON in the web UI
            if (!isClaudeChatVisibleMessage(message)) {
                return
            }
            session.client.sendClaudeSessionMessage(message)
        },
        onSessionDiscovered: (sessionId: string) => {
            session.onSessionFound(sessionId);
        }
    });

    const handleSessionFound = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(handleSessionFound);


    const launcher = new BaseLocalLauncher({
        label: 'local',
        failureLabel: 'Local Claude process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await claudeLocal({
                path: session.path,
                sessionId: session.sessionId,
                abort: abortSignal,
                claudeEnvVars: session.claudeEnvVars,
                claudeArgs: session.claudeArgs,
                mcpServers: session.mcpServers,
                allowedTools: session.allowedTools,
                hookSettingsPath: session.hookSettingsPath,
                flavor: session.flavor,
            });
        },
        onLaunchSuccess: () => {
            session.consumeOneTimeFlags();
        },
        sendFailureMessage: (message) => {
            session.client.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        },
        abortLogMessage: 'doAbort',
        switchLogMessage: 'doSwitch'
    });
    try {
        return await launcher.run();
    } finally {
        // Cleanup
        session.removeSessionFoundCallback(handleSessionFound);
        await scanner.cleanup();
    }
}
