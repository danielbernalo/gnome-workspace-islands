// Symbol.for keeps the key stable across disable/enable re-imports, so notes outlive the extension.
const PLACEMENT = Symbol.for('workspace-islands.placement');

// Never cleared: overwriting on every placement is what keeps notes right across monitor moves.
export function stamp(window, connector, index) {
    window[PLACEMENT] = { connector, index };
}

export function placementIndex(window, connector) {
    const placement = window[PLACEMENT];
    return placement?.connector === connector ? placement.index : -1;
}

export function placementConnector(window) {
    return window[PLACEMENT]?.connector ?? null;
}
