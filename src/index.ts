import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
  process.exit(1);
}

async function sendTelegramMessage(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Telegram has a 4096 char limit per message — split if needed
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }

  for (const chunk of chunks) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: chunk,
        parse_mode: 'Markdown',
      }),
    });

    if (!res.ok) {
      // Retry without markdown if parse error
      const retry = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk }),
      });
      if (!retry.ok) {
        const error = await retry.text();
        throw new Error(`Telegram API error: ${error}`);
      }
    }
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'telegram-mcp',
    version: '1.0.0',
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool(
    'send_message',
    'Send a text message to Telegram. Supports Markdown formatting.',
    { text: z.string().describe('Message text. Markdown is supported.') },
    async ({ text }: { text: string }): Promise<CallToolResult> => {
      await sendTelegramMessage(text);
      return { content: [{ type: 'text', text: 'Message sent to Telegram.' }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Webhook for CCR agents (WebFetch POST)
app.post('/send', async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text) { res.status(400).json({ ok: false, error: 'Missing text' }); return; }
  try {
    await sendTelegramMessage(text);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// MCP endpoint — each request gets its own stateless server instance
app.all('/mcp', async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Telegram MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
