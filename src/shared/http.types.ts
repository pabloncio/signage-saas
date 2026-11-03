import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ApiRequest extends IncomingMessage {
  params: Record<string, string>;
  body: unknown;
  requestId: string;
}

export type ApiResponse = ServerResponse;

export type Handler = (req: ApiRequest, res: ApiResponse, next: () => Promise<void>) => Promise<void> | void;
