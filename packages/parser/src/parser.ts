import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { Language, ParsedFile } from './index';
import { CacheStore } from '@repo-xray/types';

export function getFileLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    default:
      return 'unknown';
  }
}

// Regex based import/export extractors for fallback and non-JS/TS languages
export function extractJSTSRegex(source: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];

  // Match: import x from 'y'; import 'y'; require('y')
  const importRegexes = [
    /import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const rx of importRegexes) {
    let match: RegExpExecArray | null;
    while ((match = rx.exec(source)) !== null) {
      if (match[1]) imports.push(match[1]);
    }
  }

  // Match: export const x = ...; export function x() ...; export default ...
  const exportRegexes = [
    /export\s+(?:const|let|var|function|class|interface|type)\s+([a-zA-Z0-9_]+)/g,
    /exports\.([a-zA-Z0-9_]+)\s*=/g,
  ];

  for (const rx of exportRegexes) {
    let match: RegExpExecArray | null;
    while ((match = rx.exec(source)) !== null) {
      if (match[1]) exports.push(match[1]);
    }
  }
  if (/export\s+default/g.test(source)) {
    exports.push('default');
  }

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
  };
}

export function extractPythonRegex(source: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];

  const importRegexes = [
    /^import\s+([a-zA-Z0-9_.,\s]+)/gm,
    /^from\s+([a-zA-Z0-9_.]+)\s+import/gm,
  ];

  for (const rx of importRegexes) {
    let match: RegExpExecArray | null;
    while ((match = rx.exec(source)) !== null) {
      if (match[1]) {
        // Handle comma separated imports: import a, b, c
        const modules = match[1].split(',').map(s => s.trim().split(' ')[0]);
        imports.push(...modules);
      }
    }
  }

  const exportRegex = /^(?:def|class)\s+([a-zA-Z0-9_]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = exportRegex.exec(source)) !== null) {
    if (match[1] && !match[1].startsWith('_')) {
      exports.push(match[1]);
    }
  }

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
  };
}

export function extractGoRegex(source: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];

  // Match single imports: import "math"
  const singleImportRegex = /import\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = singleImportRegex.exec(source)) !== null) {
    if (match[1]) imports.push(match[1]);
  }

  // Match block imports: import ( "fmt" "os" )
  const blockImportRegex = /import\s*\(([\s\S]*?)\)/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockImportRegex.exec(source)) !== null) {
    const blockContent = blockMatch[1];
    const itemRegex = /['"]([^'"]+)['"]/g;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(blockContent)) !== null) {
      if (itemMatch[1]) imports.push(itemMatch[1]);
    }
  }

  // Go exports are capitalized identifiers
  const funcRegex = /func\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g;
  while ((match = funcRegex.exec(source)) !== null) {
    if (match[1]) exports.push(match[1]);
  }

  const typeRegex = /type\s+([A-Z][a-zA-Z0-9_]*)\s+struct/g;
  while ((match = typeRegex.exec(source)) !== null) {
    if (match[1]) exports.push(match[1]);
  }

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
  };
}

export function extractRustRegex(source: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];

  // Match: use std::collections::HashMap;
  const useRegex = /use\s+([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(source)) !== null) {
    if (match[1]) {
      const clean = match[1].replace(/\{[\s\S]*\}/, '').trim();
      imports.push(clean);
    }
  }

  // Match: pub fn x(), pub struct x
  const pubRegex = /pub\s+(?:fn|struct|enum|trait|type|const|mod)\s+([a-zA-Z0-9_]+)/g;
  while ((match = pubRegex.exec(source)) !== null) {
    if (match[1]) exports.push(match[1]);
  }

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
  };
}

export async function parseJSTSWithAcorn(source: string): Promise<{ imports: string[]; exports: string[]; ast?: unknown }> {
  const imports: string[] = [];
  const exports: string[] = [];
  let ast: unknown;

  try {
    ast = acorn.parse(source, {
      ecmaVersion: 2022,
      sourceType: 'module',
    });
  } catch {
    try {
      ast = acorn.parse(source, {
        ecmaVersion: 2022,
        sourceType: 'script',
      });
    } catch {
      // Return regex fallback if acorn completely fails (common for typescript)
      return { ...extractJSTSRegex(source), ast: null };
    }
  }

  walk.simple(ast as acorn.Node, {
    ImportDeclaration(node: unknown) {
      const n = node as { source?: { value?: string } };
      if (n.source && typeof n.source.value === 'string') {
        imports.push(n.source.value);
      }
    },
    ImportExpression(node: unknown) {
      const n = node as { source?: { type?: string; value?: string } };
      if (n.source && n.source.type === 'Literal' && typeof n.source.value === 'string') {
        imports.push(n.source.value);
      }
    },
    CallExpression(node: unknown) {
      const n = node as {
        callee?: { type?: string; name?: string };
        arguments?: { type?: string; value?: string }[];
      };
      if (
        n.callee &&
        n.callee.type === 'Identifier' &&
        n.callee.name === 'require' &&
        n.arguments &&
        n.arguments[0] &&
        n.arguments[0].type === 'Literal' &&
        typeof n.arguments[0].value === 'string'
      ) {
        imports.push(n.arguments[0].value);
      }
    },
    ExportNamedDeclaration(node: unknown) {
      const n = node as {
        declaration?: {
          id?: { name?: string };
          declarations?: { id?: { name?: string } }[];
        };
        specifiers?: { exported?: { name?: string } }[];
      };
      if (n.declaration) {
        if (n.declaration.id && n.declaration.id.name) {
          exports.push(n.declaration.id.name);
        } else if (n.declaration.declarations) {
          for (const decl of n.declaration.declarations) {
            if (decl.id && decl.id.name) exports.push(decl.id.name);
          }
        }
      }
      if (n.specifiers) {
        for (const spec of n.specifiers) {
          if (spec.exported && spec.exported.name) exports.push(spec.exported.name);
        }
      }
    },
    ExportDefaultDeclaration() {
      exports.push('default');
    },
    ExportAllDeclaration(node: unknown) {
      const n = node as { source?: { value?: string } };
      if (n.source && typeof n.source.value === 'string') {
        imports.push(n.source.value);
      }
    },
  });

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
    ast,
  };
}

export async function parsePythonWithSubprocess(source: string): Promise<{ imports: string[]; exports: string[] }> {
  try {
    const pyScript = `
import ast, json, sys
try:
    tree = ast.parse(sys.stdin.read())
    imports = []
    exports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for name in node.names:
                imports.append(name.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.append(node.module)
        elif isinstance(node, ast.FunctionDef) or isinstance(node, ast.ClassDef):
            if not node.name.startswith('_'):
                exports.append(node.name)
    print(json.dumps({'imports': imports, 'exports': exports}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;
    const result = spawnSync('python', ['-c', pyScript], {
      input: source,
      encoding: 'utf-8',
    });
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout);
      if (parsed && !parsed.error) {
        return {
          imports: parsed.imports || [],
          exports: parsed.exports || [],
        };
      }
    }
  } catch {
    // Fallback to regex if python is not installed or errors
  }
  return extractPythonRegex(source);
}

export async function parseFile(
  filePath: string,
  cache?: CacheStore
): Promise<ParsedFile & { ast?: unknown }> {
  const source = fs.readFileSync(filePath, 'utf-8');
  const lines = source.split(/\r?\n/).length;
  const lang = getFileLanguage(filePath);
  const hash = crypto.createHash('sha256').update(source).digest('hex');

  if (cache) {
    const cachedEntry = await cache.get(filePath);
    if (cachedEntry && cachedEntry.hash === hash) {
      return cachedEntry.value as ParsedFile;
    }
  }

  let imports: string[] = [];
  let exports: string[] = [];
  let ast: unknown = null;

  if (lang === 'javascript' || lang === 'typescript') {
    const parsed = await parseJSTSWithAcorn(source);
    imports = parsed.imports;
    exports = parsed.exports;
    ast = parsed.ast;
  } else if (lang === 'python') {
    const parsed = extractPythonRegex(source);
    imports = parsed.imports;
    exports = parsed.exports;
  } else if (lang === 'go') {
    const parsed = extractGoRegex(source);
    imports = parsed.imports;
    exports = parsed.exports;
  } else if (lang === 'rust') {
    const parsed = extractRustRegex(source);
    imports = parsed.imports;
    exports = parsed.exports;
  } else {
    const JSTS = extractJSTSRegex(source);
    imports = JSTS.imports;
    exports = JSTS.exports;
  }

  const result: ParsedFile & { ast?: unknown } = {
    path: filePath,
    language: lang,
    lines,
    imports,
    exports,
    ast,
  };

  if (cache) {
    await cache.set(filePath, {
      key: filePath,
      value: { path: result.path, language: result.language, lines: result.lines, imports: result.imports, exports: result.exports },
      hash,
      createdAt: new Date().toISOString(),
    });
  }

  return result;
}
