import { sha256 } from '../common/util';
import { ToolHandler } from './tool-invoker.service';

/** Writes an artifact descriptor. Content addressed: same content, same id. */
export class WriteArtifactTool implements ToolHandler {
  readonly key = 'write_artifact';
  async execute(args: Record<string, unknown>) {
    const path = String(args.path);
    const content = String(args.content ?? '');
    return { path, bytes: Buffer.byteLength(content), sha: sha256(content).slice(0, 12) };
  }
}

/** Simulated test runner: deterministic pass count derived from the suite name. */
export class RunTestsTool implements ToolHandler {
  readonly key = 'run_tests';
  async execute(args: Record<string, unknown>) {
    const suite = String(args.suite);
    const total = 3 + (parseInt(sha256(suite).slice(0, 2), 16) % 6);
    return { suite, total, passed: total, failed: 0 };
  }
}

/** Simulated documentation search over a tiny local index. */
export class SearchDocsTool implements ToolHandler {
  readonly key = 'search_docs';
  async execute(args: Record<string, unknown>) {
    const query = String(args.query);
    return { query, hits: [`docs/${query.split(' ')[0]?.toLowerCase() || 'index'}.md`, 'docs/architecture.md'] };
  }
}

export const BUILTIN_TOOLS: ToolHandler[] = [new WriteArtifactTool(), new RunTestsTool(), new SearchDocsTool()];
