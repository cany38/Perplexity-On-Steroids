// perplexity-on-steroids: Streamable HTTP MCP server (stateless).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BRIDGE_VERSION } from './tools.mjs';
import { createRuntime } from './runtime.mjs';
import { startPanel } from './panel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = process.env.POS_CONFIG || path.join(HERE, 'config.json');
const PORT = Number(process.env.POS_PORT || 8857);
const PANEL_PORT = Number(process.env.POS_PANEL_PORT || 8859);
const TOKEN = process.env.POS_TOKEN || null;
const runtime = createRuntime({ configPath: CFG, mcpPort: PORT, panelPort: PANEL_PORT, token: TOKEN });
const bridge = runtime.bridge;
const S = (d) => z.string().describe(d);
const B = (d) => z.boolean().optional().describe(d);
const N = (d) => z.number().optional().describe(d);
const R = (res) => ({ content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], isError: !res.ok });
const SPECS = [
  ['pos_ping', 'Check that the bridge is alive.', {}, []],
  ['pos_list_dir', 'List a directory.', { path: S('Directory path.').optional() }, ['path']],
  ['pos_read_file', 'Read a file.', { path: S('File path.'), offset: N('Byte offset.'), limit: N('Maximum bytes.') }, ['path','offset','limit']],
  ['pos_search', 'Search file contents under a root.', { path: S('Root path.').optional(), query: S('Text to search for.'), isRegex: B('Treat query as a regex.'), glob: S('File glob, e.g. *.py.'), maxHits: N('Maximum hits.') }, ['path','query','isRegex','glob','maxHits']],
  ['pos_write_file', 'Write a file. Overwrites wait for panel approval.', { path: S('Destination path.'), content: S('File contents.') }, ['path','content']],
  ['pos_edit_file', 'Literal find and replace. Waits for panel approval.', { path: S('File path.'), find: S('Text to replace.'), replace: S('Replacement text.'), all: B('Replace every match.') }, ['path','find','replace','all']],
  ['pos_delete_file', 'Delete a file or directory. Waits for panel approval.', { path: S('Path.') }, ['path']],
  ['pos_copy_file', 'Copy a file or directory recursively. Overwrites wait for panel approval.', { from: S('Source path.'), to: S('Destination path.') }, ['from','to']],
  ['pos_move_file', 'Move or rename a file or directory. Replacing waits for panel approval.', { from: S('Source path.'), to: S('Destination path.') }, ['from','to']],
  ['pos_make_dir', 'Create a directory, like mkdir -p. Waits for panel approval.', { path: S('Directory path.') }, ['path']],
  ['pos_exec_command', 'Run a shell command. Waits for panel approval.', { command: S('Command to run.'), cwd: S('Working directory.').optional(), timeoutMs: N('Timeout in milliseconds.') }, ['command','cwd','timeoutMs']],
  ['pos_batch', 'Run several tool calls in order, up to 20. Each call is checked separately.', { calls: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() })).describe('Calls to run in order') }, ['calls']],
  ['pos_list_sessions', 'List recorded sessions.', {}, []],
  ['pos_session_log', 'Read a session step log.', { id: S('Session id.'), tail: N('Number of lines.') }, ['id','tail']],
];
// Tool hints for the client. Without them MCP treats every tool as possibly
// destructive, and Perplexity asks "Reply yes to proceed" before even a directory
// listing. Reads are marked read-only; the real gate for the rest is the panel.
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const HINTS = {
  pos_ping: READ, pos_list_dir: READ, pos_read_file: READ, pos_search: READ, pos_list_sessions: READ, pos_session_log: READ,
  pos_write_file: WRITE, pos_edit_file: WRITE, pos_copy_file: WRITE, pos_move_file: WRITE, pos_make_dir: WRITE,
  pos_delete_file: DESTROY, pos_exec_command: DESTROY, pos_batch: DESTROY,
};

// Sent to the model with every connection (the MCP "instructions" field), so the
// agent knows it is already authorised and does not ask in chat.
const INSTRUCTIONS = `This connector is the user's own computer. The pos_ tools give you their files and a shell, and they installed it so you could use them.

The user has authorised every pos_ tool call you make for their requests. When they ask for something, do it right away. Don't ask them to confirm in the chat, not even with "Reply yes to proceed". Their request is their consent.

The user keeps their own check outside the chat. The tools only reach folders they approved, and a local panel on their computer holds writes, deletes and commands for their approval when their permission level says so. They answer there. If a call is denied or times out, say so in a sentence and carry on with what you can do.

Run pos_ping first. It lists the folders you can reach. Then look around with pos_list_dir, pos_search and pos_read_file before you guess. On Windows the user's files are under C:\Users. The Desktop is C:\Users\<name>\Desktop, or C:\Users\<name>\OneDrive\Desktop if OneDrive moved it.`;

function createServer() {
  const srv = new McpServer({ name: 'perplexity-on-steroids', version: BRIDGE_VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  for (const [name, desc, schema, keys] of SPECS) {
    const h = async (a) => R(await runtime.dispatch(name, keys.reduce((o, k) => (a && a[k] !== undefined ? (o[k] = a[k], o) : o), {})));
    const title = name.replace(/^pos_/, '').replace(/_/g, ' ');
    srv.registerTool(name, {
      title,
      description: desc,
      ...(keys.length ? { inputSchema: schema } : {}),
      annotations: { title, ...HINTS[name] },
    }, h);
  }
  return srv;
}
const srv = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (TOKEN && (req.headers.authorization || '') !== 'Bearer ' + TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }));
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (!runtime.acceptsMcpPath(url.pathname)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, OPTIONS' }).end(); return; }
  // Only requests from outside count as Perplexity: the relay marks what it
  // forwards, a Cloudflare tunnel adds cf-connecting-ip. Local tests do not.
  if (req.headers['x-pos-via'] === 'relay' || req.headers['cf-connecting-ip']) runtime.touch();
  try {
    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null }));
  }
});
srv.listen(PORT, '127.0.0.1', () => {
  console.log('[pos-mcp] http://127.0.0.1:' + PORT + '/mcp');
  console.log('[pos-mcp] ' + bridge.ADVERTISED.length + ' tools, roots: ' + bridge.ROOTS.join(', '));
  console.log('[pos-mcp] auth: ' + (TOKEN ? 'Bearer' : 'none'));
});

try {
  const panel = await startPanel({ runtime, port: PANEL_PORT });
  console.log('[pos-panel] ' + panel.url);
} catch (e) {
  console.log('[pos-panel] unavailable on 127.0.0.1:' + PANEL_PORT + ': ' + e.message);
}

const shutdown = () => {
  runtime.close();
  srv.close();
  setTimeout(() => process.exit(0), 300).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


