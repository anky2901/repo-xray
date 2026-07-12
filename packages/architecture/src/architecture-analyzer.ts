import * as fs from 'fs';
import * as path from 'path';
import type { ScanContext, Analyzer, Finding } from '@repo-xray/types';
import { parseFile } from '@repo-xray/parser';
import { buildIgnoreFilter, XRayConfig } from '@repo-xray/shared';

export interface DependencyNode {
  path: string;
  lines: number;
  exports: string[];
  imports: string[];
  resolvedImports: string[];
  incomingImports: string[];
}

export function resolveImportPath(
  fromFile: string,
  importStr: string,
  workspacePath: string,
  allFiles: string[]
): string | null {
  const target = importStr.trim();

  if (target.startsWith('@repo-xray/')) {
    const pkgName = target.slice('@repo-xray/'.length);
    const pkgIndex = path.join(workspacePath, 'packages', pkgName, 'src', 'index.ts');
    if (fs.existsSync(pkgIndex)) {
      return path.relative(workspacePath, pkgIndex).replace(/\\/g, '/');
    }
    const sharedIndex = path.join(workspacePath, 'shared', 'src', 'index.ts');
    if (pkgName === 'shared' && fs.existsSync(sharedIndex)) {
      return path.relative(workspacePath, sharedIndex).replace(/\\/g, '/');
    }
  }

  if (target.startsWith('.')) {
    const resolvedAbs = path.resolve(path.dirname(fromFile), target);

    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
    for (const ext of extensions) {
      const testPath = resolvedAbs + ext;
      if (fs.existsSync(testPath) && fs.statSync(testPath).isFile()) {
        return path.relative(workspacePath, testPath).replace(/\\/g, '/');
      }
    }

    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const testPath = path.join(resolvedAbs, `index${ext}`);
      if (fs.existsSync(testPath) && fs.statSync(testPath).isFile()) {
        return path.relative(workspacePath, testPath).replace(/\\/g, '/');
      }
    }
  }

  const matches = allFiles.find(f => {
    const rel = path.relative(workspacePath, f).replace(/\\/g, '/');
    return rel.endsWith(target) || rel.endsWith(target + '.ts') || rel.endsWith(target + '.js');
  });

  if (matches) {
    return path.relative(workspacePath, matches).replace(/\\/g, '/');
  }

  return null;
}

export class XRayArchitectureAnalyzer implements Analyzer {
  readonly id = 'architecture';
  readonly name = 'Architecture X-Ray';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const ignoreFilter = buildIgnoreFilter(context.workspacePath, context.config as XRayConfig);
    const sourceFiles = this.getSourceFiles(context.workspacePath).filter(f => !ignoreFilter(f));
    context.logger.info(`[M2:architecture] Building import graph for ${sourceFiles.length} files`);

    // Build the dependency graph.
    const graph: Map<string, DependencyNode> = new Map();
    for (const file of sourceFiles) {
      const relPath = path.relative(context.workspacePath, file).replace(/\\/g, '/');
      try {
        const parsed = await parseFile(file, context.cache);
        graph.set(relPath, {
          path: relPath,
          lines: parsed.lines,
          exports: parsed.exports || [],
          imports: parsed.imports || [],
          resolvedImports: [],
          incomingImports: [],
        });
      } catch (err: unknown) {
        const error = err as Error;
        context.logger.error(`[M2:architecture] Error parsing ${relPath}: ${error.message}`);
      }
    }

    for (const [relPath, node] of graph.entries()) {
      const absPath = path.join(context.workspacePath, relPath);
      for (const imp of node.imports) {
        const resolved = resolveImportPath(absPath, imp, context.workspacePath, sourceFiles);
        if (resolved && graph.has(resolved) && resolved !== relPath) {
          node.resolvedImports.push(resolved);
        }
      }
    }

    for (const node of graph.values()) {
      node.resolvedImports = Array.from(new Set(node.resolvedImports));
    }

    for (const [relPath, node] of graph.entries()) {
      for (const resolved of node.resolvedImports) {
        const targetNode = graph.get(resolved);
        if (targetNode) {
          targetNode.incomingImports.push(relPath);
        }
      }
    }

    this.detectCycles(graph, findings);
    this.detectGodFiles(graph, findings);
    this.detectLayeringViolations(graph, findings);
    this.detectDeadModules(graph, findings);
    this.writeInteractiveGraph(graph, context.config.output.dir);

    context.logger.info(`[M2:architecture] Completed — ${findings.length} findings`);
    return findings;
  }

  private detectCycles(graph: Map<string, DependencyNode>, findings: Finding[]): void {
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const currentPath: string[] = [];

    const dfs = (nodeId: string) => {
      visited.add(nodeId);
      recStack.add(nodeId);
      currentPath.push(nodeId);

      const node = graph.get(nodeId);
      if (node) {
        for (const neighbor of node.resolvedImports) {
          if (!visited.has(neighbor)) {
            dfs(neighbor);
          } else if (recStack.has(neighbor)) {
            const cycleStartIdx = currentPath.indexOf(neighbor);
            const cycle = currentPath.slice(cycleStartIdx);
            cycle.push(neighbor);

            const cycleKey = [...cycle].sort().join('->');
            const cycleId = `arch-cycle-${cycleKey.replace(/[^a-zA-Z0-9]/g, '-')}`.slice(0, 80);

            if (!findings.some(f => f.id === cycleId)) {
              if (findings.filter(f => f.title === 'Circular Dependency Detected').length >= 100) {
                return;
              }
              findings.push({
                id: cycleId,
                module: 'architecture',
                title: 'Circular Dependency Detected',
                summary: `Circular import cycle found: ${cycle.join(' → ')}`,
                severity: 'HIGH',
                confidence: 100,
                evidence: cycle.map(c => ({ file: c })),
                reasoning: `A circular dependency exists among these files: ${cycle.join(' imports ')}. Circular dependencies complicate imports, make unit testing difficult, and delay application initialization.`,
                reproducible: true,
                tags: ['dependency-cycle', 'coupling'],
              });
            }
          }
        }
      }

      recStack.delete(nodeId);
      currentPath.pop();
    };

    for (const nodeId of graph.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId);
      }
    }
  }

  private detectGodFiles(graph: Map<string, DependencyNode>, findings: Finding[]): void {
    for (const [relPath, node] of graph.entries()) {
      if (findings.filter(f => f.title === 'God File (Anti-Pattern)').length >= 100) {
        break;
      }
      if (node.lines > 500 && node.exports.length > 15 && node.incomingImports.length > 20) {
        findings.push({
          id: `arch-godfile-${relPath.replace(/[^a-zA-Z0-9-]/g, '-')}`,
          module: 'architecture',
          title: 'God File (Anti-Pattern)',
          summary: `"${relPath}" functions as a God File with high complexity and dependency coupling.`,
          severity: 'HIGH',
          confidence: 90,
          evidence: [{ file: relPath, line: 1, snippet: `Lines: ${node.lines}, Exports: ${node.exports.length}, Imported by: ${node.incomingImports.length}` }],
          reasoning: `File contains ${node.lines} lines of code, exports ${node.exports.length} items, and is imported by ${node.incomingImports.length} other files. God files violate single responsibility and are difficult to maintain.`,
          reproducible: true,
          tags: ['anti-pattern', 'cohesion'],
        });
      }
    }
  }

  private detectLayeringViolations(graph: Map<string, DependencyNode>, findings: Finding[]): void {
    for (const [relPath, node] of graph.entries()) {
      if (findings.filter(f => f.title === 'Layering Violation').length >= 100) {
        break;
      }
      const isDomain = relPath.includes('domain/') || relPath.includes('core/');
      if (!isDomain) continue;

      for (const imp of node.resolvedImports) {
        const isInfra = imp.includes('infrastructure/') || imp.includes('api/') || imp.includes('cli/') || imp.includes('web/');
        if (isInfra) {
          findings.push({
            id: `arch-violation-${relPath.replace(/[^a-zA-Z0-9]/g, '-')}-${imp.replace(/[^a-zA-Z0-9]/g, '-')}`,
            module: 'architecture',
            title: 'Layering Violation',
            summary: `Domain layer file "${relPath}" imports infrastructure layer file "${imp}".`,
            severity: 'HIGH',
            confidence: 95,
            evidence: [{ file: relPath }, { file: imp }],
            reasoning: 'The domain/core logic should remain completely isolated and independent of external delivery mechanisms or database interfaces. Infrastructure/outer layers should depend on domain, not vice versa.',
            reproducible: true,
            tags: ['layer-violation', 'clean-architecture'],
          });
        }
      }
    }
  }

  private detectDeadModules(graph: Map<string, DependencyNode>, findings: Finding[]): void {
    const entries = [
      'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'server.ts', 'server.js',
      'tsconfig.json', 'package.json', 'Makefile', 'Dockerfile', 'vitest.config.ts'
    ];

    for (const [relPath, node] of graph.entries()) {
      const name = path.basename(relPath);
      const normalizedPath = relPath.toLowerCase();
      if (
        entries.includes(name) ||
        name.includes('.test.') ||
        name.includes('.spec.') ||
        name.startsWith('test_') ||
        name.endsWith('_test.py') ||
        normalizedPath.includes('/tests/') ||
        normalizedPath.includes('/test/') ||
        normalizedPath.includes('/fixtures/') ||
        normalizedPath.includes('/fixture/')
      ) {
        continue;
      }

      if (node.incomingImports.length === 0) {
        if (relPath.startsWith('apps/') && (name === 'index.ts' || name === 'main.ts' || name === 'app.ts')) {
          continue;
        }

        if (findings.filter(f => f.title === 'Dead Module Candidate').length >= 200) {
          break;
        }

        findings.push({
          id: `arch-dead-${relPath.replace(/[^a-zA-Z0-9-]/g, '-')}`,
          module: 'architecture',
          title: 'Dead Module Candidate',
          summary: `"${relPath}" is not imported by any other source file in the repository.`,
          severity: 'MEDIUM',
          confidence: 85,
          evidence: [{ file: relPath }],
          reasoning: 'This file has 0 incoming references from other modules. If it is not a scheduled job, plugin, or CLI action entrypoint, it can likely be removed.',
          reproducible: true,
          tags: ['dead-code', 'refactoring'],
        });
      }
    }
  }

  private writeInteractiveGraph(graph: Map<string, DependencyNode>, outputDir: string): void {
    try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const nodesData = Array.from(graph.values()).map(n => {
        let group = 'healthy';
        if (n.lines > 500 && n.exports.length > 15 && n.incomingImports.length > 20) {
          group = 'god-file';
        } else if (n.resolvedImports.length > 10) {
          group = 'high-coupling';
        }
        return {
          id: n.path,
          name: path.basename(n.path),
          lines: n.lines,
          exportsCount: n.exports.length,
          importsCount: n.imports.length,
          group,
        };
      });

      const linksData: { source: string; target: string }[] = [];
      for (const node of graph.values()) {
        for (const imp of node.resolvedImports) {
          linksData.push({
            source: node.path,
            target: imp,
          });
        }
      }

      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Repo X-Ray - Interactive Dependency Graph</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      padding: 0;
      background: #1e1e2e;
      color: #cdd6f4;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    #chart {
      flex: 1;
      position: relative;
    }
    #sidebar {
      width: 350px;
      background: #11111b;
      border-left: 1px solid #313244;
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      box-shadow: -5px 0 15px rgba(0, 0, 0, 0.5);
    }
    h2 {
      margin-top: 0;
      color: #f5c2e7;
      border-bottom: 2px solid #313244;
      padding-bottom: 10px;
    }
    .node {
      stroke: #11111b;
      stroke-width: 1.5px;
      cursor: pointer;
    }
    .link {
      stroke: #585b70;
      stroke-opacity: 0.6;
      stroke-width: 1.5px;
      fill: none;
      marker-end: url(#arrow);
    }
    .text {
      font-size: 10px;
      fill: #a6adc8;
      pointer-events: none;
    }
    .detail-card {
      background: #181825;
      border-radius: 8px;
      padding: 15px;
      margin-top: 15px;
      border: 1px solid #313244;
    }
    .label {
      font-weight: bold;
      color: #89b4fa;
    }
    .value {
      float: right;
      color: #a6e3a1;
    }
    .legend {
      position: absolute;
      bottom: 20px;
      left: 20px;
      background: rgba(17, 17, 27, 0.9);
      padding: 15px;
      border-radius: 8px;
      border: 1px solid #313244;
    }
    .legend-item {
      display: flex;
      align-items: center;
      margin-bottom: 5px;
    }
    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-right: 10px;
    }
  </style>
</head>
<body>
  <div id="chart">
    <div class="legend">
      <div class="legend-item">
        <div class="legend-color" style="background: #f38ba8;"></div>
        <span>God File</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #fab387;"></div>
        <span>High Coupling</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #a6e3a1;"></div>
        <span>Healthy</span>
      </div>
    </div>
  </div>
  <div id="sidebar">
    <h2>Module Details</h2>
    <div id="details-content">
      <p>Click on any node in the dependency graph to inspect its imports, exports, and coupling metrics.</p>
    </div>
  </div>

  <script>
    const nodes = ${JSON.stringify(nodesData)};
    const links = ${JSON.stringify(linksData)};

    const width = document.getElementById('chart').clientWidth || 800;
    const height = document.getElementById('chart').clientHeight || 600;

    // Initialize positions randomly near center
    nodes.forEach(n => {
      n.x = width / 2 + (Math.random() - 0.5) * 300;
      n.y = height / 2 + (Math.random() - 0.5) * 300;
      n.vx = 0;
      n.vy = 0;
    });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    document.getElementById('chart').appendChild(svg);

    // Create marker for arrows
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'arrow');
    marker.setAttribute('viewBox', '0 -5 10 10');
    marker.setAttribute('refX', '18');
    marker.setAttribute('refY', '0');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M0,-5L10,0L0,5');
    path.setAttribute('fill', '#585b70');
    marker.appendChild(path);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.appendChild(g);

    // Create link elements
    const linkElements = links.map(l => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'link');
      g.appendChild(line);
      return { line, source: nodes.find(n => n.id === l.source), target: nodes.find(n => n.id === l.target) };
    });

    // Create node elements
    let draggedNode = null;
    const nodeElements = nodes.map(n => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'node');
      circle.setAttribute('r', Math.min(20, 8 + n.lines / 100));
      circle.setAttribute('fill', n.group === 'god-file' ? '#f38ba8' : n.group === 'high-coupling' ? '#fab387' : '#a6e3a1');
      circle.addEventListener('click', (e) => {
        e.stopPropagation();
        showDetails(n);
      });
      
      circle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        draggedNode = n;
        n.fx = e.clientX;
        n.fy = e.clientY;
      });

      g.appendChild(circle);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('class', 'text');
      text.textContent = n.name;
      g.appendChild(text);

      return { circle, text, node: n };
    });

    svg.addEventListener('mousemove', (e) => {
      if (draggedNode) {
        const rect = svg.getBoundingClientRect();
        draggedNode.x = (e.clientX - rect.left - panX) / scale;
        draggedNode.y = (e.clientY - rect.top - panY) / scale;
      }
    });

    window.addEventListener('mouseup', () => {
      draggedNode = null;
    });

    // Simple zoom / pan using mouse wheel and drag-background
    let panX = 0, panY = 0, scale = 1;
    let isPanning = false;
    let startX = 0, startY = 0;

    svg.addEventListener('mousedown', (e) => {
      isPanning = true;
      startX = e.clientX - panX;
      startY = e.clientY - panY;
    });

    window.addEventListener('mousemove', (e) => {
      if (isPanning && !draggedNode) {
        panX = e.clientX - startX;
        panY = e.clientY - startY;
         g.setAttribute('transform', \`translate(\${panX}, \${panY}) scale(\${scale})\`);
      }
    });

    window.addEventListener('mouseup', () => {
      isPanning = false;
    });

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = 1.1;
      const rect = svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Zoom towards mouse pointer
      const localX = (mouseX - panX) / scale;
      const localY = (mouseY - panY) / scale;

      if (e.deltaY < 0) {
        scale *= zoomFactor;
      } else {
        scale /= zoomFactor;
      }

      panX = mouseX - localX * scale;
      panY = mouseY - localY * scale;

      g.setAttribute('transform', \`translate(\${panX}, \${panY}) scale(\${scale})\`);
    });

     function showDetails(d) {
       const content = document.getElementById('details-content');
       content.innerHTML = \`
         <div class="detail-card">
           <h3>\\\${d.name}</h3>
           <p><span class="label">Path:</span> <span class="value" style="font-size:11px; word-break:break-all;">\\\${d.id}</span></p>
           <p><span class="label">Lines of Code:</span> <span class="value">\\\${d.lines}</span></p>
           <p><span class="label">Exports Count:</span> <span class="value">\\\${d.exportsCount}</span></p>
           <p><span class="label">Imports Count:</span> <span class="value">\\\${d.importsCount}</span></p>
           <p><span class="label">Module Class:</span> <span class="value" style="color:\\\${d.group === 'god-file' ? '#f38ba8' : d.group === 'high-coupling' ? '#fab387' : '#a6e3a1'}">\\\${d.group.toUpperCase()}</span></p>
         </div>
       \`;
     }

    // Force-directed layout tick
    function tick() {
      const k = 100;
      const gravity = 0.03;

      for (let i = 0; i < nodes.length; i++) {
        const n1 = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const n2 = nodes[j];
          const dx = n2.x - n1.x;
          const dy = n2.y - n1.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist < 300) {
            const force = (k * k) / dist;
            const fx = (dx / dist) * force * 0.15;
            const fy = (dy / dist) * force * 0.15;
            if (draggedNode !== n1) { n1.vx -= fx; n1.vy -= fy; }
            if (draggedNode !== n2) { n2.vx += fx; n2.vy += fy; }
          }
        }
      }

      linkElements.forEach(l => {
        if (!l.source || !l.target) return;
        const dx = l.target.x - l.source.x;
        const dy = l.target.y - l.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - k) * 0.08;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (draggedNode !== l.source) { l.source.vx += fx; l.source.vy += fy; }
        if (draggedNode !== l.target) { l.target.vx -= fx; l.target.vy -= fy; }
      });

      nodes.forEach(n => {
        if (n === draggedNode) return;
        
        const dx = width / 2 - n.x;
        const dy = height / 2 - n.y;
        n.vx += dx * gravity;
        n.vy += dy * gravity;

        n.vx *= 0.85;
        n.vy *= 0.85;

        const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        const maxSpeed = 15;
        if (speed > maxSpeed) {
          n.vx = (n.vx / speed) * maxSpeed;
          n.vy = (n.vy / speed) * maxSpeed;
        }

        n.x += n.vx;
        n.y += n.vy;
      });

      linkElements.forEach(l => {
        if (!l.source || !l.target) return;
        l.line.setAttribute('x1', l.source.x);
        l.line.setAttribute('y1', l.source.y);
        l.line.setAttribute('x2', l.target.x);
        l.line.setAttribute('y2', l.target.y);
      });

      nodeElements.forEach(ne => {
        ne.circle.setAttribute('cx', ne.node.x);
        ne.circle.setAttribute('cy', ne.node.y);
        ne.text.setAttribute('x', ne.node.x + 12);
        ne.text.setAttribute('y', ne.node.y + 4);
      });

      requestAnimationFrame(tick);
    }

    tick();
  </script>
</body>
</html>
`;
      fs.writeFileSync(path.join(outputDir, 'ARCHITECTURE.html'), htmlContent, 'utf-8');
    } catch {}
  }

  private getSourceFiles(dir: string): string[] {
    const results: string[] = [];
    const ignoreList = [
      'node_modules',
      '.git',
      'dist',
      'build',
      '__pycache__',
      'vendor',
      '.cache',
      '.xray-cache',
      '.xray-reports',
    ];

    function walk(current: string): void {
      if (!fs.existsSync(current)) return;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (ignoreList.includes(entry.name)) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].includes(ext)) {
            results.push(full);
          }
        }
      }
    }

    walk(dir);
    return results;
  }

  async exportReport(context: ScanContext, format: 'json' | 'markdown'): Promise<string> {
    const findings = await this.scan(context);
    if (format === 'json') {
      return JSON.stringify(findings, null, 2);
    }
    return `# Architecture Report`;
  }
}
