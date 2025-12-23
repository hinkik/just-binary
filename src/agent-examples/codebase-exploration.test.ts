import { describe, it, expect } from 'vitest';
import { BashEnv } from '../BashEnv.js';

/**
 * Codebase Exploration Scenario
 * An AI agent exploring a monorepo structure to understand the architecture.
 */
describe('Agent Scenario: Codebase Exploration', () => {
  const createEnv = () =>
    new BashEnv({
      files: {
        '/repo/package.json': `{
  "name": "monorepo",
  "workspaces": ["packages/*"]
}`,
        '/repo/packages/core/package.json': `{
  "name": "@app/core",
  "version": "1.0.0"
}`,
        '/repo/packages/core/src/index.ts': `export { Database } from './db';
export { Logger } from './logger';
`,
        '/repo/packages/core/src/db.ts': `export class Database {
  connect() {}
  query() {}
}
`,
        '/repo/packages/core/src/logger.ts': `export class Logger {
  info(msg: string) {}
  error(msg: string) {}
}
`,
        '/repo/packages/api/package.json': `{
  "name": "@app/api",
  "dependencies": {
    "@app/core": "1.0.0"
  }
}`,
        '/repo/packages/api/src/index.ts': `import { Database } from '@app/core';
const db = new Database();
`,
        '/repo/packages/web/package.json': `{
  "name": "@app/web",
  "dependencies": {
    "@app/api": "1.0.0"
  }
}`,
        '/repo/packages/web/src/App.tsx': `export function App() {
  return <div>Hello</div>;
}
`,
      },
      cwd: '/repo',
    });

  it('should list root directory', async () => {
    const env = createEnv();
    const result = await env.exec('ls /repo');
    expect(result.stdout).toBe('package.json\npackages\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should read root package.json for workspaces', async () => {
    const env = createEnv();
    const result = await env.exec('cat /repo/package.json');
    expect(result.stdout).toBe(`{
  "name": "monorepo",
  "workspaces": ["packages/*"]
}`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should list all packages', async () => {
    const env = createEnv();
    const result = await env.exec('ls /repo/packages');
    expect(result.stdout).toBe('api\ncore\nweb\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should explore core package structure', async () => {
    const env = createEnv();
    const result = await env.exec('ls /repo/packages/core');
    expect(result.stdout).toBe('package.json\nsrc\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should list core source files', async () => {
    const env = createEnv();
    const result = await env.exec('ls /repo/packages/core/src');
    expect(result.stdout).toBe('db.ts\nindex.ts\nlogger.ts\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should read core exports', async () => {
    const env = createEnv();
    const result = await env.exec('cat /repo/packages/core/src/index.ts');
    expect(result.stdout).toBe(`export { Database } from './db';
export { Logger } from './logger';
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find all class definitions', async () => {
    const env = createEnv();
    const result = await env.exec('grep -r "^export class" /repo/packages/core/src');
    expect(result.stdout).toBe(`/repo/packages/core/src/db.ts:export class Database {
/repo/packages/core/src/logger.ts:export class Logger {
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find package dependencies on core', async () => {
    const env = createEnv();
    const result = await env.exec('grep -r "@app/core" /repo/packages');
    expect(result.stdout).toBe(`/repo/packages/api/package.json:    "@app/core": "1.0.0"
/repo/packages/api/src/index.ts:import { Database } from '@app/core';
/repo/packages/core/package.json:  "name": "@app/core",
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should check api package dependencies', async () => {
    const env = createEnv();
    const result = await env.exec('cat /repo/packages/api/package.json');
    expect(result.stdout).toBe(`{
  "name": "@app/api",
  "dependencies": {
    "@app/core": "1.0.0"
  }
}`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find all imports of Database', async () => {
    const env = createEnv();
    const result = await env.exec('grep -r "Database" /repo/packages');
    expect(result.stdout).toBe(`/repo/packages/api/src/index.ts:import { Database } from '@app/core';
/repo/packages/api/src/index.ts:const db = new Database();
/repo/packages/core/src/db.ts:export class Database {
/repo/packages/core/src/index.ts:export { Database } from './db';
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find React components', async () => {
    const env = createEnv();
    const result = await env.exec('grep -r "function App" /repo/packages/web');
    expect(result.stdout).toBe('/repo/packages/web/src/App.tsx:export function App() {\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should count files in each package', async () => {
    const env = createEnv();
    const result = await env.exec('ls /repo/packages/core/src | wc -l');
    expect(result.stdout).toBe('       3\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
