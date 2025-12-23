import { describe, it, expect } from 'vitest';
import { BashEnv } from '../BashEnv.js';

/**
 * Advanced Agent Scenario: Security Audit
 *
 * Simulates an AI agent performing a security audit:
 * - Finding hardcoded secrets and credentials
 * - Identifying unsafe patterns (eval, innerHTML, SQL injection risks)
 * - Checking configuration files for security issues
 * - Analyzing authentication/authorization code
 */
describe('Agent Scenario: Security Audit', () => {
  const createEnv = () =>
    new BashEnv({
      files: {
        '/app/src/config.ts': `export const config = {
  apiKey: 'sk-1234567890abcdef',
  dbPassword: 'super_secret_password',
  jwtSecret: 'my-jwt-secret-key',
  port: 3000,
};
`,
        '/app/src/auth/login.ts': `import { config } from '../config';

export async function login(username: string, password: string) {
  // WARNING: SQL injection vulnerability
  const query = \`SELECT * FROM users WHERE username = '\${username}' AND password = '\${password}'\`;

  // Unsafe: using eval
  const userData = eval(response.body);

  return userData;
}
`,
        '/app/src/auth/jwt.ts': `import jwt from 'jsonwebtoken';
import { config } from '../config';

export function signToken(payload: object) {
  return jwt.sign(payload, config.jwtSecret);
}

export function verifyToken(token: string) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}
`,
        '/app/src/api/users.ts': `import { Request, Response } from 'express';

export function getUser(req: Request, res: Response) {
  const userId = req.params.id;
  // Missing authorization check!
  const user = db.findUser(userId);
  res.json(user);
}

export function deleteUser(req: Request, res: Response) {
  // No auth check - anyone can delete!
  db.deleteUser(req.params.id);
  res.json({ success: true });
}
`,
        '/app/src/api/render.ts': `export function renderUserProfile(user: { name: string; bio: string }) {
  // XSS vulnerability: innerHTML with user data
  document.getElementById('profile').innerHTML = \`
    <h1>\${user.name}</h1>
    <p>\${user.bio}</p>
  \`;
}

export function safeRender(user: { name: string }) {
  // Safe: using textContent
  document.getElementById('name').textContent = user.name;
}
`,
        '/app/.env': `DATABASE_URL=postgresql://admin:password123@localhost:5432/myapp
API_SECRET=very-secret-key
AWS_ACCESS_KEY=AKIA1234567890ABCDEF
AWS_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
`,
        '/app/.env.example': `DATABASE_URL=postgresql://user:password@localhost:5432/dbname
API_SECRET=your-api-secret
AWS_ACCESS_KEY=your-aws-access-key
AWS_SECRET_KEY=your-aws-secret-key
`,
        '/app/package.json': `{
  "name": "vulnerable-app",
  "dependencies": {
    "express": "^4.17.0",
    "lodash": "4.17.20",
    "jsonwebtoken": "^8.5.0"
  }
}
`,
        '/app/docker-compose.yml': `version: '3'
services:
  db:
    image: postgres
    environment:
      POSTGRES_PASSWORD: admin123
      POSTGRES_USER: admin
`,
      },
      cwd: '/app',
    });

  it('should find hardcoded API keys and secrets', async () => {
    const env = createEnv();
    // Search specifically in config.ts to avoid matching function parameters
    const result = await env.exec('grep -n "apiKey\\|secret\\|password" /app/src/config.ts');
    expect(result.stdout).toBe(`2:  apiKey: 'sk-1234567890abcdef',
3:  dbPassword: 'super_secret_password',
4:  jwtSecret: 'my-jwt-secret-key',
`);
    expect(result.exitCode).toBe(0);
  });

  it('should find SQL injection vulnerabilities', async () => {
    const env = createEnv();
    // Search for SQL queries with string interpolation
    const result = await env.exec('grep -n "SELECT.*\\$" /app/src/auth/login.ts');
    expect(result.stdout).toBe("5:  const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;\n");
    expect(result.exitCode).toBe(0);
  });

  it('should find dangerous eval usage', async () => {
    const env = createEnv();
    const result = await env.exec('grep -rn "eval(" /app/src');
    expect(result.stdout).toBe('/app/src/auth/login.ts:8:  const userData = eval(response.body);\n');
    expect(result.exitCode).toBe(0);
  });

  it('should find XSS vulnerabilities with innerHTML', async () => {
    const env = createEnv();
    const result = await env.exec('grep -rn "innerHTML" /app/src');
    // Both the comment and the actual innerHTML usage match
    expect(result.stdout).toBe(`/app/src/api/render.ts:2:  // XSS vulnerability: innerHTML with user data
/app/src/api/render.ts:3:  document.getElementById('profile').innerHTML = \`
`);
    expect(result.exitCode).toBe(0);
  });

  it('should find missing authorization checks', async () => {
    const env = createEnv();
    // Look for route handlers that don't check auth
    const result = await env.exec('grep -B2 -A5 "function.*req.*res" /app/src/api/users.ts');
    expect(result.stdout).toBe(`import { Request, Response } from 'express';

export function getUser(req: Request, res: Response) {
  const userId = req.params.id;
  // Missing authorization check!
  const user = db.findUser(userId);
  res.json(user);
}

export function deleteUser(req: Request, res: Response) {
  // No auth check - anyone can delete!
  db.deleteUser(req.params.id);
  res.json({ success: true });
}
`);
    expect(result.exitCode).toBe(0);
  });

  it('should find sensitive data in .env file', async () => {
    const env = createEnv();
    const result = await env.exec('grep -n "KEY\\|SECRET\\|PASSWORD" /app/.env');
    expect(result.stdout).toBe(`2:API_SECRET=very-secret-key
3:AWS_ACCESS_KEY=AKIA1234567890ABCDEF
4:AWS_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
`);
    expect(result.exitCode).toBe(0);
  });

  it('should find hardcoded credentials in docker-compose', async () => {
    const env = createEnv();
    const result = await env.exec('grep -n "PASSWORD\\|password" /app/docker-compose.yml');
    expect(result.stdout).toBe(`6:      POSTGRES_PASSWORD: admin123
`);
    expect(result.exitCode).toBe(0);
  });

  it('should check for vulnerable dependencies', async () => {
    const env = createEnv();
    // lodash 4.17.20 has known vulnerabilities
    const result = await env.exec('grep "lodash" /app/package.json');
    expect(result.stdout).toBe('    "lodash": "4.17.20",\n');
    expect(result.exitCode).toBe(0);
  });

  it('should generate security findings summary', async () => {
    const env = createEnv();

    // Count different vulnerability types
    const evalCount = await env.exec('grep -r -c "eval(" /app/src | grep -v ":0$" | wc -l');
    const innerHtmlCount = await env.exec('grep -r -c "innerHTML" /app/src | grep -v ":0$" | wc -l');
    const secretsInCode = await env.exec('grep -rn "secret\\|password\\|apiKey" /app/src/config.ts | wc -l');

    expect(evalCount.stdout.trim()).toBe('1');
    expect(innerHtmlCount.stdout.trim()).toBe('1');
    expect(secretsInCode.stdout.trim()).toBe('3');
  });

  it('should find all files that need security review', async () => {
    const env = createEnv();
    const result = await env.exec('find /app/src -name "*.ts" | sort');
    expect(result.stdout).toBe(`/app/src/api/render.ts
/app/src/api/users.ts
/app/src/auth/jwt.ts
/app/src/auth/login.ts
/app/src/config.ts
`);
    expect(result.exitCode).toBe(0);
  });

  it('should compare .env with .env.example for undocumented secrets', async () => {
    const env = createEnv();
    // Get variable names from both files
    const envVars = await env.exec("grep -o '^[A-Z_]*' /app/.env | sort");
    const exampleVars = await env.exec("grep -o '^[A-Z_]*' /app/.env.example | sort");

    expect(envVars.stdout).toBe(`API_SECRET
AWS_ACCESS_KEY
AWS_SECRET_KEY
DATABASE_URL
`);
    expect(exampleVars.stdout).toBe(`API_SECRET
AWS_ACCESS_KEY
AWS_SECRET_KEY
DATABASE_URL
`);
  });

  it('should identify auth-related files for focused review', async () => {
    const env = createEnv();
    const result = await env.exec('find /app/src -type f -name "*auth*" -o -type f -name "*login*" -o -type f -name "*jwt*" | sort');
    expect(result.stdout).toBe(`/app/src/auth/jwt.ts
/app/src/auth/login.ts
`);
    expect(result.exitCode).toBe(0);
  });
});
