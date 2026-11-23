// Shell imports resolve to globalThis.__wiFakes, else inert stubs; export names come from src/.

import { readdirSync, readFileSync } from 'node:fs';

const PREFIX = 'wi-shell:';
const SHELL_SPECIFIER = /^(?:gi:\/\/|resource:\/\/\/)/;

function exportsBySpecifier() {
    const names = new Map();
    const add = (specifier, name) => {
        if (!names.has(specifier))
            names.set(specifier, new Set());
        names.get(specifier).add(name);
    };

    const src = new URL('../../src/', import.meta.url);
    for (const file of readdirSync(src).filter(f => f.endsWith('.js'))) {
        const text = readFileSync(new URL(file, src), 'utf8');

        const named = /import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*'((?:gi|resource):[^']+)'/g;
        for (const [, list, specifier] of text.matchAll(named)) {
            for (const entry of list.split(',')) {
                const name = entry.trim().split(/\s+as\s+/)[0];
                if (name)
                    add(specifier, name);
            }
        }

        const namespaces = /import\s+\*\s+as\s+(\w+)\s+from\s*'((?:gi|resource):[^']+)'/g;
        for (const [, alias, specifier] of text.matchAll(namespaces)) {
            for (const [, member] of text.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g')))
                add(specifier, member);
        }
    }

    return names;
}

const EXPORTS = exportsBySpecifier();

export async function resolve(specifier, context, next) {
    if (SHELL_SPECIFIER.test(specifier))
        return { url: PREFIX + specifier, shortCircuit: true };

    return next(specifier, context);
}

export async function load(url, context, next) {
    if (!url.startsWith(PREFIX))
        return next(url, context);

    const specifier = url.slice(PREFIX.length);
    const names = [...(EXPORTS.get(specifier) ?? [])].filter(name => name !== 'default');

    const source = [
        'const stub = new Proxy(function () {}, {',
        "    get: (_target, key) => (key === 'then' ? undefined : stub),",
        '    apply: () => stub,',
        '    construct: () => stub,',
        '});',
        `const fake = globalThis.__wiFakes?.[${JSON.stringify(specifier)}] ?? {};`,
        'export default fake.default ?? stub;',
        ...names.map(name => `export const ${name} = fake.${name} ?? stub;`),
    ].join('\n');

    return { format: 'module', source, shortCircuit: true };
}
