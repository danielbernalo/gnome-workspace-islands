/**
 * Module hooks that let the extension's pure-JS modules load under Node.
 *
 * `gi://` and `resource:///` only exist inside a running GNOME Shell. Every
 * such import is answered with an inert stand-in: any property read, call or
 * construction returns the stand-in again, so modules evaluate their top level
 * (class declarations, GObject.registerClass, constants) without a shell.
 *
 * Tests exercise logic, not the shell. Anything a test needs to observe from a
 * shell object is passed in as a fake by the test itself.
 */

const STUB = 'stub:';

// Named imports have to exist as real exports, or the module fails to link.
// Keep this list in step with what src/ imports by name from the shell.
const NAMES = [
    'ANIMATION_TIME', 'Extension', 'ExtensionPreferences', 'ExtraWorkspaceView',
    'InjectionManager', 'WindowManager', 'Workspace', 'WorkspaceBackground',
    'gettext', 'lerp',
    // Members read off `import * as Main`.
    'actionMode', 'createWorkspacesAdjustment', 'layoutManager', 'notifyError',
    'overview', 'panel', 'sessionMode', 'uiGroup', 'wm',
];

export async function resolve(specifier, context, next) {
    if (specifier.startsWith('gi://') || specifier.startsWith('resource:///'))
        return { url: STUB + specifier, shortCircuit: true };

    return next(specifier, context);
}

export async function load(url, context, next) {
    if (!url.startsWith(STUB))
        return next(url, context);

    const source = `
        const stub = new Proxy(function () {}, {
            get: (_target, key) => (key === 'then' ? undefined : stub),
            apply: () => stub,
            construct: () => stub,
        });
        export default stub;
        ${NAMES.map(name => `export const ${name} = stub;`).join('\n')}
    `;

    return { format: 'module', source, shortCircuit: true };
}
