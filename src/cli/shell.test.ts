import { describe, it, expect } from 'vitest';
import { BashEnv } from '../BashEnv.js';

/**
 * Tests for shell-like functionality in BashEnv.
 * The actual interactive shell is tested manually.
 */
describe('Shell functionality', () => {
  describe('cd command', () => {
    it('should change directory', async () => {
      const env = new BashEnv({
        files: { '/home/user/test/.keep': '' },
        cwd: '/home/user',
      });

      await env.exec('cd test');
      expect(env.getCwd()).toBe('/home/user/test');
    });

    it('should support cd -', async () => {
      const env = new BashEnv({
        files: {
          '/dir1/.keep': '',
          '/dir2/.keep': '',
        },
        cwd: '/',
      });

      await env.exec('cd /dir1');
      await env.exec('cd /dir2');
      await env.exec('cd -');
      expect(env.getCwd()).toBe('/dir1');
    });

    it('should support cd ~', async () => {
      const env = new BashEnv({
        files: { '/home/user/.keep': '' },
        cwd: '/tmp',
        env: { HOME: '/home/user' },
      });

      await env.exec('cd ~');
      expect(env.getCwd()).toBe('/home/user');
    });

    it('should support cd without args', async () => {
      const env = new BashEnv({
        files: { '/home/user/.keep': '' },
        cwd: '/tmp',
        env: { HOME: '/home/user' },
      });

      await env.exec('cd');
      expect(env.getCwd()).toBe('/home/user');
    });

    it('should support cd ..', async () => {
      const env = new BashEnv({
        files: { '/a/b/c/.keep': '' },
        cwd: '/a/b/c',
      });

      await env.exec('cd ..');
      expect(env.getCwd()).toBe('/a/b');
    });

    it('should support cd with multiple .. in path', async () => {
      const env = new BashEnv({
        files: { '/a/b/c/d/.keep': '' },
        cwd: '/a/b/c/d',
      });

      await env.exec('cd ../..');
      expect(env.getCwd()).toBe('/a/b');
    });
  });

  describe('pwd command', () => {
    it('should return current directory', async () => {
      const env = new BashEnv({
        cwd: '/home/user',
      });

      const result = await env.exec('pwd');
      expect(result.stdout).toBe('/home/user\n');
    });

    it('should reflect cd changes', async () => {
      const env = new BashEnv({
        files: { '/var/log/.keep': '' },
        cwd: '/',
      });

      await env.exec('cd /var/log');
      const result = await env.exec('pwd');
      expect(result.stdout).toBe('/var/log\n');
    });
  });

  describe('command chaining', () => {
    it('should support && chaining', async () => {
      const env = new BashEnv({
        files: { '/test/.keep': '' },
        cwd: '/',
      });

      const result = await env.exec('cd /test && pwd');
      expect(result.stdout).toBe('/test\n');
      expect(env.getCwd()).toBe('/test');
    });

    it('should stop && chain on failure', async () => {
      const env = new BashEnv({
        cwd: '/',
      });

      const result = await env.exec('cd /nonexistent && pwd');
      expect(result.exitCode).toBe(1);
      expect(env.getCwd()).toBe('/');
    });

    it('should support || chaining', async () => {
      const env = new BashEnv({
        files: { '/fallback/.keep': '' },
        cwd: '/',
      });

      const result = await env.exec('cd /nonexistent || cd /fallback && pwd');
      expect(result.stdout).toBe('/fallback\n');
      expect(env.getCwd()).toBe('/fallback');
    });

    it('should support ; chaining', async () => {
      const env = new BashEnv({
        files: { '/test/.keep': '' },
        cwd: '/',
      });

      const result = await env.exec('cd /test ; pwd');
      expect(result.stdout).toBe('/test\n');
    });
  });

  describe('environment variables', () => {
    it('should support export', async () => {
      const env = new BashEnv();

      await env.exec('export MY_VAR=hello');
      const result = await env.exec('echo $MY_VAR');
      expect(result.stdout).toBe('hello\n');
    });

    it('should support unset', async () => {
      const env = new BashEnv({
        env: { MY_VAR: 'hello' },
      });

      await env.exec('unset MY_VAR');
      const result = await env.exec('echo $MY_VAR');
      expect(result.stdout).toBe('\n');
    });
  });

  describe('exit command', () => {
    it('should return exit code 0 by default', async () => {
      const env = new BashEnv();
      const result = await env.exec('exit');
      expect(result.exitCode).toBe(0);
    });

    it('should return specified exit code', async () => {
      const env = new BashEnv();
      const result = await env.exec('exit 42');
      expect(result.exitCode).toBe(42);
    });
  });
});
