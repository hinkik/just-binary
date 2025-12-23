import { describe, it, expect } from 'vitest';
import { BashEnv } from '../../BashEnv.js';

describe('sed command', () => {
  const createEnv = () =>
    new BashEnv({
      files: {
        '/test/file.txt': 'hello world\nhello universe\ngoodbye world\n',
        '/test/numbers.txt': 'line 1\nline 2\nline 3\nline 4\nline 5\n',
        '/test/names.txt': 'John Smith\nJane Doe\nBob Johnson\n',
      },
      cwd: '/test',
    });

  it('should replace first occurrence per line', async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/hello/hi/' /test/file.txt");
    expect(result.stdout).toBe('hi world\nhi universe\ngoodbye world\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should replace all occurrences with g flag', async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/l/L/g' /test/file.txt");
    expect(result.stdout).toBe('heLLo worLd\nheLLo universe\ngoodbye worLd\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should print specific line with -n and line number', async () => {
    const env = createEnv();
    const result = await env.exec("sed -n '3p' /test/numbers.txt");
    expect(result.stdout).toBe('line 3\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should print range of lines', async () => {
    const env = createEnv();
    const result = await env.exec("sed -n '2,4p' /test/numbers.txt");
    expect(result.stdout).toBe('line 2\nline 3\nline 4\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should delete matching lines', async () => {
    const env = createEnv();
    const result = await env.exec("sed '/hello/d' /test/file.txt");
    expect(result.stdout).toBe('goodbye world\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should delete specific line number', async () => {
    const env = createEnv();
    const result = await env.exec("sed '2d' /test/numbers.txt");
    expect(result.stdout).toBe('line 1\nline 3\nline 4\nline 5\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should read from stdin via pipe', async () => {
    const env = createEnv();
    const result = await env.exec("echo 'foo bar' | sed 's/bar/baz/'");
    expect(result.stdout).toBe('foo baz\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should use different delimiter', async () => {
    const env = createEnv();
    const result = await env.exec("echo '/path/to/file' | sed 's#/path#/newpath#'");
    expect(result.stdout).toBe('/newpath/to/file\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should handle regex patterns in substitution', async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/[0-9]/X/' /test/numbers.txt");
    expect(result.stdout).toBe('line X\nline X\nline X\nline X\nline X\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should return error for non-existent file', async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/a/b/' /test/nonexistent.txt");
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('sed: /test/nonexistent.txt: No such file or directory\n');
    expect(result.exitCode).toBe(1);
  });

  it('should handle empty replacement', async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/world//' /test/file.txt");
    expect(result.stdout).toBe('hello \nhello universe\ngoodbye \n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('should delete range of lines', async () => {
    const env = createEnv();
    const result = await env.exec("sed '2,4d' /test/numbers.txt");
    expect(result.stdout).toBe('line 1\nline 5\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  describe('case insensitive flag (i)', () => {
    it('should replace case insensitively with i flag', async () => {
      const env = createEnv();
      const result = await env.exec("sed 's/HELLO/hi/i' /test/file.txt");
      expect(result.stdout).toBe('hi world\nhi universe\ngoodbye world\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('should combine i and g flags', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'Hello HELLO hello\n' },
        cwd: '/',
      });
      const result = await env.exec("sed 's/hello/hi/gi' /test.txt");
      expect(result.stdout).toBe('hi hi hi\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('address ranges with substitute', () => {
    it('should substitute only on line 1', async () => {
      const env = createEnv();
      const result = await env.exec("sed '1s/line/LINE/' /test/numbers.txt");
      expect(result.stdout).toBe('LINE 1\nline 2\nline 3\nline 4\nline 5\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('should substitute only on line 2', async () => {
      const env = createEnv();
      const result = await env.exec("sed '2s/line/LINE/' /test/numbers.txt");
      expect(result.stdout).toBe('line 1\nLINE 2\nline 3\nline 4\nline 5\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('should substitute on last line with $', async () => {
      const env = createEnv();
      const result = await env.exec("sed '$ s/line/LINE/' /test/numbers.txt");
      expect(result.stdout).toBe('line 1\nline 2\nline 3\nline 4\nLINE 5\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('should substitute on range of lines', async () => {
      const env = createEnv();
      const result = await env.exec("sed '2,4s/line/LINE/' /test/numbers.txt");
      expect(result.stdout).toBe('line 1\nLINE 2\nLINE 3\nLINE 4\nline 5\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('$ address for delete', () => {
    it('should delete last line with $d', async () => {
      const env = createEnv();
      const result = await env.exec("sed '$ d' /test/numbers.txt");
      expect(result.stdout).toBe('line 1\nline 2\nline 3\nline 4\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('should delete last line without space', async () => {
      const env = createEnv();
      const result = await env.exec("sed '$d' /test/numbers.txt");
      expect(result.stdout).toBe('line 1\nline 2\nline 3\nline 4\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('multiple expressions (-e)', () => {
    it('should apply multiple -e expressions', async () => {
      const env = createEnv();
      const result = await env.exec("sed -e 's/hello/hi/' -e 's/world/there/' /test/file.txt");
      expect(result.stdout).toBe('hi there\nhi universe\ngoodbye there\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('should apply three -e expressions', async () => {
      const env = createEnv();
      const result = await env.exec("sed -e 's/line/LINE/' -e 's/1/one/' -e 's/2/two/' /test/numbers.txt");
      expect(result.stdout).toBe('LINE one\nLINE two\nLINE 3\nLINE 4\nLINE 5\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('& replacement (matched text)', () => {
    it('should replace & with matched text', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'hello\n' },
        cwd: '/',
      });
      const result = await env.exec("sed 's/hello/[&]/' /test.txt");
      expect(result.stdout).toBe('[hello]\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('should handle multiple & in replacement', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'world\n' },
        cwd: '/',
      });
      const result = await env.exec("sed 's/world/&-&-&/' /test.txt");
      expect(result.stdout).toBe('world-world-world\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('should handle escaped & in replacement', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'hello\n' },
        cwd: '/',
      });
      const result = await env.exec("sed 's/hello/\\&/' /test.txt");
      expect(result.stdout).toBe('&\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('in-place editing (-i)', () => {
    it('should edit file in-place with -i', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'hello world\n' },
        cwd: '/',
      });
      const result = await env.exec("sed -i 's/hello/hi/' /test.txt");
      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);

      // Verify file was modified
      const cat = await env.exec('cat /test.txt');
      expect(cat.stdout).toBe('hi world\n');
    });

    it('should edit file in-place with global replacement', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'foo foo foo\nbar foo bar\n' },
        cwd: '/',
      });
      const result = await env.exec("sed -i 's/foo/baz/g' /test.txt");
      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);

      const cat = await env.exec('cat /test.txt');
      expect(cat.stdout).toBe('baz baz baz\nbar baz bar\n');
    });

    it('should delete lines in-place', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'line 1\nline 2\nline 3\n' },
        cwd: '/',
      });
      const result = await env.exec("sed -i '2d' /test.txt");
      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);

      const cat = await env.exec('cat /test.txt');
      expect(cat.stdout).toBe('line 1\nline 3\n');
    });

    it('should delete matching lines in-place', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'keep this\nremove this\nkeep that\n' },
        cwd: '/',
      });
      const result = await env.exec("sed -i '/remove/d' /test.txt");
      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);

      const cat = await env.exec('cat /test.txt');
      expect(cat.stdout).toBe('keep this\nkeep that\n');
    });

    it('should edit multiple files in-place', async () => {
      const env = new BashEnv({
        files: {
          '/a.txt': 'hello\n',
          '/b.txt': 'hello\n',
        },
        cwd: '/',
      });
      const result = await env.exec("sed -i 's/hello/hi/' /a.txt /b.txt");
      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);

      const catA = await env.exec('cat /a.txt');
      expect(catA.stdout).toBe('hi\n');

      const catB = await env.exec('cat /b.txt');
      expect(catB.stdout).toBe('hi\n');
    });

    it('should handle --in-place flag', async () => {
      const env = new BashEnv({
        files: { '/test.txt': 'old text\n' },
        cwd: '/',
      });
      const result = await env.exec("sed --in-place 's/old/new/' /test.txt");
      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);

      const cat = await env.exec('cat /test.txt');
      expect(cat.stdout).toBe('new text\n');
    });
  });
});
