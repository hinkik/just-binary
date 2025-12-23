import { describe, it, expect } from 'vitest';
import { BashEnv } from '../../BashEnv.js';

describe('find command', () => {
  const createEnv = () =>
    new BashEnv({
      files: {
        '/project/README.md': '# Project',
        '/project/src/index.ts': 'export {}',
        '/project/src/utils/helpers.ts': 'export function helper() {}',
        '/project/src/utils/format.ts': 'export function format() {}',
        '/project/tests/index.test.ts': 'test("works", () => {})',
        '/project/package.json': '{}',
        '/project/tsconfig.json': '{}',
      },
      cwd: '/project',
    });

  it('should find all files and directories from path', async () => {
    const env = createEnv();
    const result = await env.exec('find /project');
    expect(result.stdout).toBe(`/project
/project/README.md
/project/package.json
/project/src
/project/src/index.ts
/project/src/utils
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests
/project/tests/index.test.ts
/project/tsconfig.json
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find files by name pattern', async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "*.ts"');
    expect(result.stdout).toBe(`/project/src/index.ts
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests/index.test.ts
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find files only with -type f', async () => {
    const env = createEnv();
    const result = await env.exec('find /project -type f');
    expect(result.stdout).toBe(`/project/README.md
/project/package.json
/project/src/index.ts
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests/index.test.ts
/project/tsconfig.json
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find directories only with -type d', async () => {
    const env = createEnv();
    const result = await env.exec('find /project -type d');
    expect(result.stdout).toBe(`/project
/project/src
/project/src/utils
/project/tests
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find files matching JSON pattern', async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "*.json"');
    expect(result.stdout).toBe(`/project/package.json
/project/tsconfig.json
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find from current directory with .', async () => {
    const env = createEnv();
    const result = await env.exec('find . -name "*.md"');
    expect(result.stdout).toBe('./README.md\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should combine -name and -type', async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "*.ts" -type f');
    expect(result.stdout).toBe(`/project/src/index.ts
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests/index.test.ts
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find specific filename', async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "index.ts"');
    expect(result.stdout).toBe('/project/src/index.ts\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should return error for non-existent path', async () => {
    const env = createEnv();
    const result = await env.exec('find /nonexistent');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe("find: /nonexistent: No such file or directory\n");
    expect(result.exitCode).toBe(1);
  });

  it('should find test files', async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "*.test.ts"');
    expect(result.stdout).toBe('/project/tests/index.test.ts\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should handle ? wildcard in name pattern', async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "???*.json"');
    expect(result.stdout).toBe(`/project/package.json
/project/tsconfig.json
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  // OR operator tests
  describe('-o flag (OR)', () => {
    it('should find files matching either pattern with -o', async () => {
      const env = createEnv();
      const result = await env.exec('find /project -name "*.md" -o -name "*.json"');
      expect(result.stdout).toBe(`/project/README.md
/project/package.json
/project/tsconfig.json
`);
      expect(result.exitCode).toBe(0);
    });

    it('should support -or as alias for -o', async () => {
      const env = createEnv();
      const result = await env.exec('find /project -name "*.md" -or -name "*.json"');
      expect(result.stdout).toBe(`/project/README.md
/project/package.json
/project/tsconfig.json
`);
      expect(result.exitCode).toBe(0);
    });

    it('should give AND higher precedence than OR', async () => {
      const env = createEnv();
      // This should find: (files named *.md) OR (files named *.json)
      // NOT: files named (*.md OR *.json) - which would be the same in this case
      const result = await env.exec('find /project -type f -name "*.md" -o -type f -name "*.json"');
      expect(result.stdout).toBe(`/project/README.md
/project/package.json
/project/tsconfig.json
`);
      expect(result.exitCode).toBe(0);
    });

    it('should work with multiple OR conditions', async () => {
      const env = new BashEnv({
        files: {
          '/dir/a.txt': '',
          '/dir/b.md': '',
          '/dir/c.json': '',
          '/dir/d.ts': '',
        },
      });
      const result = await env.exec('find /dir -name "*.txt" -o -name "*.md" -o -name "*.json"');
      expect(result.stdout).toBe(`/dir/a.txt
/dir/b.md
/dir/c.json
`);
      expect(result.exitCode).toBe(0);
    });

    it('should combine type and name with OR correctly', async () => {
      const env = createEnv();
      // Find TypeScript files OR any directory
      const result = await env.exec('find /project -type f -name "*.ts" -o -type d');
      // All .ts files plus all directories
      expect(result.stdout).toContain('/project/src/index.ts');
      expect(result.stdout).toContain('/project\n');
      expect(result.stdout).toContain('/project/src\n');
      expect(result.exitCode).toBe(0);
    });

    it('should find auth-related files', async () => {
      const env = new BashEnv({
        files: {
          '/app/src/auth/login.ts': '',
          '/app/src/auth/jwt.ts': '',
          '/app/src/api/users.ts': '',
        },
      });
      const result = await env.exec('find /app/src -type f -name "*auth*" -o -type f -name "*login*" -o -type f -name "*jwt*"');
      expect(result.stdout).toBe(`/app/src/auth/jwt.ts
/app/src/auth/login.ts
`);
      expect(result.exitCode).toBe(0);
    });
  });

  // AND operator tests
  describe('-a flag (AND)', () => {
    it('should work with explicit -a flag', async () => {
      const env = createEnv();
      const result = await env.exec('find /project -type f -a -name "*.ts"');
      expect(result.stdout).toBe(`/project/src/index.ts
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests/index.test.ts
`);
      expect(result.exitCode).toBe(0);
    });

    it('should support -and as alias', async () => {
      const env = createEnv();
      const result = await env.exec('find /project -type f -and -name "*.json"');
      expect(result.stdout).toBe(`/project/package.json
/project/tsconfig.json
`);
      expect(result.exitCode).toBe(0);
    });
  });
});
