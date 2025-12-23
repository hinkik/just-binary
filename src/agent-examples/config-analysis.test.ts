import { describe, it, expect } from 'vitest';
import { BashEnv } from '../BashEnv.js';

/**
 * Config Analysis Scenario
 * An AI agent analyzing configuration files across environments.
 */
describe('Agent Scenario: Config Analysis', () => {
  const createEnv = () =>
    new BashEnv({
      files: {
        '/app/config/default.json': `{
  "port": 3000,
  "database": {
    "host": "localhost",
    "port": 5432
  },
  "cache": {
    "enabled": false
  }
}`,
        '/app/config/production.json': `{
  "port": 8080,
  "database": {
    "host": "db.prod.example.com",
    "port": 5432
  },
  "cache": {
    "enabled": true
  }
}`,
        '/app/config/staging.json': `{
  "port": 8080,
  "database": {
    "host": "db.staging.example.com",
    "port": 5432
  },
  "cache": {
    "enabled": true
  }
}`,
        '/app/.env.example': `DATABASE_URL=postgresql://localhost:5432/app
API_KEY=your-api-key-here
DEBUG=false
`,
        '/app/.env.production': `DATABASE_URL=postgresql://db.prod.example.com:5432/app
API_KEY=prod-secret-key
DEBUG=false
`,
      },
      cwd: '/app',
    });

  it('should list config files', async () => {
    const env = createEnv();
    const result = await env.exec('ls /app/config');
    expect(result.stdout).toBe('default.json\nproduction.json\nstaging.json\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should read default configuration', async () => {
    const env = createEnv();
    const result = await env.exec('cat /app/config/default.json');
    expect(result.stdout).toBe(`{
  "port": 3000,
  "database": {
    "host": "localhost",
    "port": 5432
  },
  "cache": {
    "enabled": false
  }
}`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should read production configuration', async () => {
    const env = createEnv();
    const result = await env.exec('cat /app/config/production.json');
    expect(result.stdout).toBe(`{
  "port": 8080,
  "database": {
    "host": "db.prod.example.com",
    "port": 5432
  },
  "cache": {
    "enabled": true
  }
}`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find port configurations', async () => {
    const env = createEnv();
    const result = await env.exec('grep "port" /app/config/default.json');
    expect(result.stdout).toBe(`  "port": 3000,
    "port": 5432
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find all database hosts across configs', async () => {
    const env = createEnv();
    const result = await env.exec('grep -r "host" /app/config');
    expect(result.stdout).toBe(`/app/config/default.json:    "host": "localhost",
/app/config/production.json:    "host": "db.prod.example.com",
/app/config/staging.json:    "host": "db.staging.example.com",
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find cache settings', async () => {
    const env = createEnv();
    const result = await env.exec('grep -r "enabled" /app/config');
    expect(result.stdout).toBe(`/app/config/default.json:    "enabled": false
/app/config/production.json:    "enabled": true
/app/config/staging.json:    "enabled": true
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should list env files', async () => {
    const env = createEnv();
    const result = await env.exec('ls -a /app');
    // ls -a includes . and .. entries
    expect(result.stdout).toBe('.\n..\n.env.example\n.env.production\nconfig\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should read env example file', async () => {
    const env = createEnv();
    const result = await env.exec('cat /app/.env.example');
    expect(result.stdout).toBe(`DATABASE_URL=postgresql://localhost:5432/app
API_KEY=your-api-key-here
DEBUG=false
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find DATABASE_URL across env files', async () => {
    const env = createEnv();
    const result = await env.exec('grep DATABASE_URL /app/.env.example /app/.env.production');
    expect(result.stdout).toBe(`/app/.env.example:DATABASE_URL=postgresql://localhost:5432/app
/app/.env.production:DATABASE_URL=postgresql://db.prod.example.com:5432/app
`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should count config lines', async () => {
    const env = createEnv();
    const result = await env.exec('wc -l /app/config/default.json');
    // wc counts newlines, not lines of text. The file has 10 lines but no trailing newline = 9 newlines
    expect(result.stdout).toBe('       9 /app/config/default.json\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should find differences in port settings', async () => {
    const env = createEnv();
    const result = await env.exec('grep 3000 /app/config/default.json');
    expect(result.stdout).toBe('  "port": 3000,\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should verify production uses different port', async () => {
    const env = createEnv();
    const result = await env.exec('grep 8080 /app/config/production.json');
    expect(result.stdout).toBe('  "port": 8080,\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
