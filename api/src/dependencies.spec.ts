import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

describe('dependency pins (L1)', () => {
  it('resolves multer 2.5.0 (GHSA-q7qp-rjg7-q26m fixed) under @nestjs/platform-express', () => {
    const from = dirname(require.resolve('@nestjs/platform-express/package.json'));
    const pkg = JSON.parse(readFileSync(require.resolve('multer/package.json', { paths: [from] }), 'utf8'));
    expect(pkg.version).toBe('2.5.0');
    const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/multer'].version).toBe('2.5.0');
  });
});
