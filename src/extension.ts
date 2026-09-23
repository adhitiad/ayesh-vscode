import * as vscode from 'vscode';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface HealthReply {
  healthy: boolean;
  version: string;
  postgres_connected: boolean;
  redis_connected: boolean;
}

interface Skill {
  name: string;
  description?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let output: vscode.OutputChannel;

function host(): string {
  return vscode.workspace.getConfiguration('ayesh').get<string>('grpcHost', 'localhost:50051');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getClient(ctx: vscode.ExtensionContext): any {
  if (client) return client;
  const protoPath = path.join(ctx.extensionPath, 'proto', 'ayesh.proto');
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root = grpc.loadPackageDefinition(definition) as any;
  client = new root.ayesh.AyeshService(host(), grpc.credentials.createInsecure());
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call<T>(ctx: vscode.ExtensionContext, method: string, request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    getClient(ctx)[method](request, (err: Error | null, res: T) => (err ? reject(err) : resolve(res)));
  });
}

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  output.appendLine(`[error] ${msg}`);
  void vscode.window.showErrorMessage(`Ayesh: ${msg}`);
}

async function healthCheck(ctx: vscode.ExtensionContext): Promise<void> {
  try {
    const h = await call<HealthReply>(ctx, 'HealthCheck', {});
    const status = `healthy=${h.healthy} v${h.version} pg=${h.postgres_connected} redis=${h.redis_connected}`;
    output.appendLine(`[health] ${status}`);
    if (h.healthy) void vscode.window.showInformationMessage(`Ayesh: ${status}`);
    else void vscode.window.showWarningMessage(`Ayesh: ${status}`);
  } catch (e) {
    fail(e);
  }
}

async function listSkills(ctx: vscode.ExtensionContext): Promise<void> {
  try {
    const s = await call<{ skills: Skill[] }>(ctx, 'ListSkills', {});
    output.clear();
    for (const sk of s.skills) output.appendLine(`${sk.name} — ${(sk.description ?? '').split('\n')[0]}`);
    output.show(true);
  } catch (e) {
    fail(e);
  }
}

function chatStream(ctx: vscode.ExtensionContext, message: string): Thenable<string> {
  return new Promise((resolve, reject) => {
    const stream = getClient(ctx).ChatStream();
    let content = '';
    stream.on('data', (chunk: { token?: string; done?: boolean; usage?: unknown }) => {
      if (chunk.token) content += chunk.token;
      if (chunk.done) {
        stream.end();
        output.appendLine(`[usage] ${JSON.stringify(chunk.usage ?? null)}`);
        resolve(content);
      }
    });
    stream.on('error', reject);
    stream.write({ message, session_id: 'vscode', interrupt: false });
  });
}

async function chat(ctx: vscode.ExtensionContext): Promise<void> {
  const message = await vscode.window.showInputBox({
    prompt: 'Ayesh — tulis pesan',
    placeHolder: 'mis. ringkas file ini',
  });
  if (!message) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Ayesh berpikir…' },
    async () => {
      try {
        const content = await chatStream(ctx, message);
        output.appendLine(`[you] ${message}`);
        output.appendLine(`[ayesh] ${content}`);
        output.show(true);
        const pick = await vscode.window.showInformationMessage(
          `Ayesh: ${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`,
          'Buka output',
          'Salin'
        );
        if (pick === 'Salin') await vscode.env.clipboard.writeText(content);
        else if (pick === 'Buka output') output.show(true);
      } catch (e) {
        fail(e);
      }
    }
  );
}

export function activate(ctx: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Ayesh');
  ctx.subscriptions.push(output);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ayesh.health', () => void healthCheck(ctx)),
    vscode.commands.registerCommand('ayesh.skills', () => void listSkills(ctx)),
    vscode.commands.registerCommand('ayesh.chat', () => void chat(ctx))
  );

  // Best-effort health check saat startup (gagal = diam, jangan spam)
  call<HealthReply>(ctx, 'HealthCheck', {})
    .then((h) => {
      if (h.healthy) output.appendLine(`[startup] server OK v${h.version} (${host()})`);
    })
    .catch((e: unknown) => output.appendLine(`[startup] server tidak terjangkau: ${(e as Error).message}`));
}

export function deactivate(): void {
  client?.close?.();
}
