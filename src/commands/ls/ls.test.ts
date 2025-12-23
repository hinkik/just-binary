import { describe, it, expect } from 'vitest';
import { BashEnv } from '../../BashEnv.js';

describe('ls', () => {
  it('should list directory contents', async () => {
    const env = new BashEnv({
      files: {
        '/dir/a.txt': '',
        '/dir/b.txt': '',
      },
    });
    const result = await env.exec('ls /dir');
    expect(result.stdout).toBe('a.txt\nb.txt\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should list current directory by default', async () => {
    const env = new BashEnv({
      files: { '/file.txt': '' },
      cwd: '/',
    });
    const result = await env.exec('ls');
    expect(result.stdout).toBe('file.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should hide hidden files by default', async () => {
    const env = new BashEnv({
      files: {
        '/dir/.hidden': '',
        '/dir/visible.txt': '',
      },
    });
    const result = await env.exec('ls /dir');
    expect(result.stdout).toBe('visible.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should show hidden files with -a including . and ..', async () => {
    const env = new BashEnv({
      files: {
        '/dir/.hidden': '',
        '/dir/visible.txt': '',
      },
    });
    const result = await env.exec('ls -a /dir');
    expect(result.stdout).toBe('.\n..\n.hidden\nvisible.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should show hidden files with --all including . and ..', async () => {
    const env = new BashEnv({
      files: { '/dir/.secret': '' },
    });
    const result = await env.exec('ls --all /dir');
    expect(result.stdout).toBe('.\n..\n.secret\n');
    expect(result.stderr).toBe('');
  });

  it('should support long format with -l', async () => {
    const env = new BashEnv({
      files: { '/dir/test.txt': '' },
    });
    const result = await env.exec('ls -l /dir');
    expect(result.stdout).toBe('total 1\n-rw-r--r-- 1 user user    0 Jan  1 00:00 test.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should show directory indicator in long format', async () => {
    const env = new BashEnv({
      files: { '/dir/subdir/file.txt': '' },
    });
    const result = await env.exec('ls -l /dir');
    expect(result.stdout).toBe('total 1\ndrwxr-xr-x 1 user user    0 Jan  1 00:00 subdir/\n');
    expect(result.stderr).toBe('');
  });

  it('should combine -la flags including . and ..', async () => {
    const env = new BashEnv({
      files: {
        '/dir/.hidden': '',
        '/dir/visible': '',
      },
    });
    const result = await env.exec('ls -la /dir');
    expect(result.stdout).toBe('total 4\ndrwxr-xr-x 1 user user    0 Jan  1 00:00 .\ndrwxr-xr-x 1 user user    0 Jan  1 00:00 ..\n-rw-r--r-- 1 user user    0 Jan  1 00:00 .hidden\n-rw-r--r-- 1 user user    0 Jan  1 00:00 visible\n');
    expect(result.stderr).toBe('');
  });

  it('should list multiple directories', async () => {
    const env = new BashEnv({
      files: {
        '/dir1/a.txt': '',
        '/dir2/b.txt': '',
      },
    });
    const result = await env.exec('ls /dir1 /dir2');
    expect(result.stdout).toBe('/dir1:\na.txt\n\n/dir2:\nb.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should list recursively with -R', async () => {
    const env = new BashEnv({
      files: {
        '/dir/subdir/file.txt': '',
        '/dir/root.txt': '',
      },
    });
    const result = await env.exec('ls -R /dir');
    // First dir has no header, subdirs use path/subdir: format
    expect(result.stdout).toBe('root.txt\nsubdir\n\n/dir/subdir:\nfile.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should error on missing directory', async () => {
    const env = new BashEnv();
    const result = await env.exec('ls /nonexistent');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe("ls: /nonexistent: No such file or directory\n");
    expect(result.exitCode).toBe(2);
  });

  it('should list a single file', async () => {
    const env = new BashEnv({
      files: { '/file.txt': 'content' },
    });
    const result = await env.exec('ls /file.txt');
    expect(result.stdout).toBe('/file.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should handle glob pattern with find and grep workaround', async () => {
    const env = new BashEnv({
      files: {
        '/dir/a.txt': '',
        '/dir/b.txt': '',
        '/dir/c.md': '',
      },
    });
    const result = await env.exec('ls /dir | grep txt');
    expect(result.stdout).toBe('a.txt\nb.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should sort entries alphabetically', async () => {
    const env = new BashEnv({
      files: {
        '/dir/zebra.txt': '',
        '/dir/apple.txt': '',
        '/dir/mango.txt': '',
      },
    });
    const result = await env.exec('ls /dir');
    expect(result.stdout).toBe('apple.txt\nmango.txt\nzebra.txt\n');
    expect(result.stderr).toBe('');
  });

  it('should handle empty directory', async () => {
    const env = new BashEnv({
      files: { '/empty/.keep': '' },
    });
    await env.exec('rm /empty/.keep');
    const result = await env.exec('ls /empty');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  describe('-A flag (almost all)', () => {
    it('should show hidden files except . and ..', async () => {
      const env = new BashEnv({
        files: {
          '/dir/.hidden': '',
          '/dir/visible.txt': '',
        },
      });
      const result = await env.exec('ls -A /dir');
      expect(result.stdout).toBe('.hidden\nvisible.txt\n');
      expect(result.stderr).toBe('');
    });

    it('should differ from -a (no . and ..)', async () => {
      const env = new BashEnv({
        files: {
          '/dir/.config': '',
          '/dir/data.txt': '',
        },
      });
      const resultA = await env.exec('ls -A /dir');
      const resulta = await env.exec('ls -a /dir');
      // -A should NOT include . and ..
      expect(resultA.stdout).toBe('.config\ndata.txt\n');
      // -a should include . and ..
      expect(resulta.stdout).toBe('.\n..\n.config\ndata.txt\n');
    });
  });

  describe('-r flag (reverse)', () => {
    it('should reverse sort order', async () => {
      const env = new BashEnv({
        files: {
          '/dir/aaa.txt': '',
          '/dir/bbb.txt': '',
          '/dir/ccc.txt': '',
        },
      });
      const result = await env.exec('ls -r /dir');
      expect(result.stdout).toBe('ccc.txt\nbbb.txt\naaa.txt\n');
      expect(result.stderr).toBe('');
    });

    it('should combine with -1 flag', async () => {
      const env = new BashEnv({
        files: {
          '/dir/x.txt': '',
          '/dir/y.txt': '',
          '/dir/z.txt': '',
        },
      });
      const result = await env.exec('ls -1r /dir');
      expect(result.stdout).toBe('z.txt\ny.txt\nx.txt\n');
      expect(result.stderr).toBe('');
    });

    it('should combine with -a flag including . and .. reversed', async () => {
      const env = new BashEnv({
        files: {
          '/dir/.hidden': '',
          '/dir/visible': '',
        },
      });
      const result = await env.exec('ls -ar /dir');
      // With -a, entries are [., .., .hidden, visible], reversed = [visible, .hidden, .., .]
      expect(result.stdout).toBe('visible\n.hidden\n..\n.\n');
      expect(result.stderr).toBe('');
    });
  });
});
