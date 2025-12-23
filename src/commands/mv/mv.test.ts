import { describe, it, expect } from 'vitest';
import { BashEnv } from '../../BashEnv.js';

describe('mv', () => {
  it('should move file', async () => {
    const env = new BashEnv({
      files: { '/old.txt': 'content' },
    });
    const result = await env.exec('mv /old.txt /new.txt');
    expect(result.exitCode).toBe(0);
    const content = await env.readFile('/new.txt');
    expect(content).toBe('content');
  });

  it('should remove source after move', async () => {
    const env = new BashEnv({
      files: { '/old.txt': 'content' },
    });
    await env.exec('mv /old.txt /new.txt');
    const cat = await env.exec('cat /old.txt');
    expect(cat.exitCode).toBe(1);
  });

  it('should rename file in same directory', async () => {
    const env = new BashEnv({
      files: { '/dir/oldname.txt': 'content' },
    });
    await env.exec('mv /dir/oldname.txt /dir/newname.txt');
    const content = await env.readFile('/dir/newname.txt');
    expect(content).toBe('content');
  });

  it('should move file to directory', async () => {
    const env = new BashEnv({
      files: {
        '/file.txt': 'content',
        '/dir/.keep': '',
      },
    });
    await env.exec('mv /file.txt /dir/');
    const content = await env.readFile('/dir/file.txt');
    expect(content).toBe('content');
  });

  it('should move multiple files to directory', async () => {
    const env = new BashEnv({
      files: {
        '/a.txt': 'aaa',
        '/b.txt': 'bbb',
        '/dir/.keep': '',
      },
    });
    await env.exec('mv /a.txt /b.txt /dir');
    expect(await env.readFile('/dir/a.txt')).toBe('aaa');
    expect(await env.readFile('/dir/b.txt')).toBe('bbb');
  });

  it('should error when moving multiple files to non-directory', async () => {
    const env = new BashEnv({
      files: {
        '/a.txt': '',
        '/b.txt': '',
      },
    });
    const result = await env.exec('mv /a.txt /b.txt /nonexistent');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a directory');
  });

  it('should move directory', async () => {
    const env = new BashEnv({
      files: { '/srcdir/file.txt': 'content' },
    });
    await env.exec('mv /srcdir /dstdir');
    const content = await env.readFile('/dstdir/file.txt');
    expect(content).toBe('content');
    const ls = await env.exec('ls /srcdir');
    expect(ls.exitCode).not.toBe(0);
  });

  it('should move nested directories', async () => {
    const env = new BashEnv({
      files: {
        '/src/a/b/c.txt': 'deep',
        '/src/root.txt': 'root',
      },
    });
    await env.exec('mv /src /dst');
    expect(await env.readFile('/dst/a/b/c.txt')).toBe('deep');
    expect(await env.readFile('/dst/root.txt')).toBe('root');
  });

  it('should overwrite destination file', async () => {
    const env = new BashEnv({
      files: {
        '/src.txt': 'new',
        '/dst.txt': 'old',
      },
    });
    await env.exec('mv /src.txt /dst.txt');
    const content = await env.readFile('/dst.txt');
    expect(content).toBe('new');
  });

  it('should error on missing source', async () => {
    const env = new BashEnv();
    const result = await env.exec('mv /missing.txt /dst.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("mv: cannot stat '/missing.txt': No such file or directory\n");
  });

  it('should error with missing destination', async () => {
    const env = new BashEnv({
      files: { '/src.txt': '' },
    });
    const result = await env.exec('mv /src.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('mv: missing destination file operand\n');
  });

  it('should move with relative paths', async () => {
    const env = new BashEnv({
      files: { '/home/user/old.txt': 'content' },
      cwd: '/home/user',
    });
    await env.exec('mv old.txt new.txt');
    const content = await env.readFile('/home/user/new.txt');
    expect(content).toBe('content');
  });

  it('should move directory into existing directory', async () => {
    const env = new BashEnv({
      files: {
        '/src/file.txt': 'content',
        '/dst/.keep': '',
      },
    });
    await env.exec('mv /src /dst/');
    const content = await env.readFile('/dst/src/file.txt');
    expect(content).toBe('content');
  });
});
