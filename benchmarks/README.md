# Benchmarks

Reference timings for deep-mode scans (all modules) on Node 22, warm cache.

| Repo    | Time  | Peak memory | Output files |
|---------|-------|-------------|--------------|
| lodash  | ~31s  | ~190 MB     | 27           |
| express | ~43s  | ~145 MB     | 27           |
| fastapi | ~67s  | ~274 MB     | 27           |

Reproduce a single run:

```bash
node apps/cli/dist/index.js scan https://github.com/expressjs/express --mode=deep --output=benchmark/express
```

Timings vary with machine and network (first run populates the OSV/registry caches; later runs
reuse them). Memory is the process peak working set.
