export function isCodexFamilyFlavor(flavor?: string | null): boolean {
    return flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode'
}

export function isClaudeFlavor(flavor?: string | null): boolean {
    return flavor === 'claude' || flavor === 'claude-internal'
}

export function isCursorFlavor(flavor?: string | null): boolean {
    return flavor === 'cursor'
}

export function isKnownFlavor(flavor?: string | null): boolean {
    return isClaudeFlavor(flavor) || isCodexFamilyFlavor(flavor) || isCursorFlavor(flavor)
}
